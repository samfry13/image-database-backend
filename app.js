const express = require('express');
const HttpStatus = require('http-status-codes');
const morgan = require('morgan');
const bodyParser = require('body-parser');
const packageConfig = require('./package.json');
const path = require('path');
const fs = require('fs');
const Busboy = require('busboy');
const cors = require('cors');
const uuid = require('uuid');

// Set up mongo
const mongoUsername = process.env.MONGO_USERNAME;
const mongoPassword = process.env.MONGO_PASSWORD;
const mongoHost = process.env.MONGO_HOST || "localhost";
const mongoPort = process.env.MONGO_PORT || 27017;
const MongoClient = require('mongodb').MongoClient;
const mongoURL = `mongodb://${mongoUsername}:${mongoPassword}@${mongoHost}:${mongoPort}/?authSource=image-database`;

const app = express();
MongoClient.connect(mongoURL, { useUnifiedTopology: true }).then(client => {
    console.log("Connected to Database");
    const db = client.db("test-image-database");
    const images = db.collection("images");
    const tags = db.collection("tags");

    app.use(morgan('combined'));
    app.use('/api/files/images', express.static('images'));
    app.use(bodyParser.json());
    app.use(bodyParser.urlencoded({ extended: false }));
	app.use(cors({origin: true}));

    app.get('/api', (req, res) => {
        return res.status(HttpStatus.OK).json({
            msg: 'OK',
            service: 'Image Database API Server'
        });
    });

    // ---------------------- Database Operations ------------------------------------
    /*
     * Gets an image, or many images, depending on what is being passed in.
     * If an id is passed in, just one with that ID will be returned.
     * If no id is passed in, then it will return many, defaulting pageSize to 15 and pageNum to 1
     *
     * Query Parameters:
     *  id => id of single image
     *
     *  pageSize => size of page
     *  pageNum => specific page number
     *
     * @return {JSON} sends a json array for many objects and just one object for a single id query
     */
    app.get('/api/image/db', (req, res) => {
		if (req.query.id) {
			images.findOne({_id: req.query.id}, (err, result) => {
				if (err) {
					console.error(err);
					return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
                        "msg": "Error: Internal Server Error - " + err
                    });
				}

				if (result == null) {
					return res.status(HttpStatus.NOT_FOUND).json({
						"msg": "Error: Not Found"
					});
				}

				console.log("Mongo Get Image - _id=" + req.query.id);
				return res.status(HttpStatus.OK).json(result);
			});
		}
		else {
            let pageSize = parseInt(req.query.pageSize) || 15;
            let pageNum = parseInt(req.query.pageNum) || 1;
            let skipAmount = pageSize * (pageNum - 1);
			images.find({}, {skip: skipAmount, limit: pageSize}, async (err, result) => {
				if (err) {
					console.error(err);
					return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
                        "msg": "Error: Internal Server Error - " + err
                    });
				}
				
				if (result == null) {
					return res.status(HttpStatus.NOT_FOUND).json({
						"msg": "Error: Not Found"
					})
				}
				
				console.log("Mongo Get All Images");
				return res.status(HttpStatus.OK).json(await result.toArray());
			});
		}
    });

    /*
     * Inserts a new image into the database. This operation should be done after
     * an image has been posted to the storage container, and a URL is returned. That
     * way, a URL can be passed into this function.
     *
     * Body: a document to be inserted into the images collection.
     *  Example:
     *  {
     *      _id: <unique-id>,
     *      createdAt: <timestamp>
     *      description: <description of image>
     *      filePath: <URL returned from /api/image/storage endpoint>
     *      tags: <array of tag strings from tags collection>
     *      title: <title of image>
     *      updatedAt: <timestamp>
     *  }
     *
     * @returns {json} a message whether or not the operation was successful or not
     */
    app.post('/api/image/db', (req, res) => {
        images.insertOne(req.body, (err, result) => {
            if (err) {
                if (err.code == 11000) {
                    return res.status(409).json({
                        "msg": "Error: Record Already Exists at id=" + req.body._id
                    });
                }

                console.error(err);
                return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
                    "msg": "Error: Internal Server Error - " + err
                });
            }

            console.log("Mongo Insert Image - _id=" + result.insertedId);
            return res.status(HttpStatus.OK).json({
                "msg": "Successfully added image _id=" + result.insertedId
            });
        });
    });

    app.put('/api/image/db', (req, res) => {
        images.updateOne({_id: req.body["_id"]}, req.body, (err, result) => {
            if (err) {
                console.error(err);
                return res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(err);
            }

            console.log("Mongo Update Image - _id=" + result.upsertedId);
            return res.status(HttpStatus.OK).json({
                "msg": "Successfully updated image _id=" + result.upsertedId
            });
        });
    });

    app.delete('/api/image/db', (req, res) => {
        images.deleteOne(req.body, (err, result) => {
            if (err) {
                console.error(err);
                return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
                    "msg": "Error Internal Server Error - " + err
                });
            }
            
            if (result.deletedCount == 0) {
                return res.status(HttpStatus.NOT_FOUND).json({
                    "msg": "Error: Image not found"
                });
            }

            console.log("Mongo Delete Image - _id=" + req.body._id);
            return res.status(HttpStatus.OK).json({
                "msg": "Successfully deleted image _id=" + req.body._id
            });
        });
    });

    // ---------------------- Storage Operations ------------------------------------
    app.delete('/api/image/storage', (req, res) => {
        fs.unlink(path.join(__dirname, 'images', path.basename(req.query.file)), (err) => {
            if (err) {
                if (err.code == "ENOENT") {
                    return res.status(HttpStatus.NOT_FOUND).json({
                        "msg": "Error: Image not found"
                    });
                }

                console.error(err);
                return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
                    "msg" : "Error: Internal Server Error - " + err
                });
            }

            console.log("Deleted File - " + req.query.file);
            return res.status(HttpStatus.OK).json({
                "msg": "Successfully deleted image - " + req.query.file
            });
        });
    });

    app.post('/api/image/storage', (req, res) => {
        let fileId = uuid.v1();
        let filePath = "/api/images/" + fileId;
        let busboy = new Busboy({
            headers: req.headers
        });
        busboy.on('file', function(fieldname, file, filename, encoding, mimetype) {
            filePath += "." + filename.split(".")[1];
            file.on('data', function(data) {
                process.stdout.write('Uploading File [' + filename + '] got ' + data.length + ' bytes\r');
            });
            file.on('end', function() {
                console.log('\nUploading File [' + filename + '] Finished');
            });
            let saveTo = path.join(__dirname, 'images', path.basename(fileId + "." + filename.split(".")[1]));
            let outStream = fs.createWriteStream(saveTo);
            console.log("Saved to: " + saveTo);
            file.pipe(outStream);
        });
        busboy.on('finish', function() {
            res.writeHead(HttpStatus.OK, {
                'Connection': 'close',
                'Content-Type': 'application/json'
            });
            res.write(JSON.stringify({
                msg: "Successfully uploaded file",
                url: filePath
            }));
            res.end();
        });
        return req.pipe(busboy);
    });

    // ---------------------- Tags Operations ------------------------------------
    /*
     * Gets all of the tags from the tags collection
     */
    app.get('/api/tags', (req, res) => {
        tags.find().toArray().then(items => {
            res.status(HttpStatus.OK).json(items);
        }).catch(err => {
            res.status(HttpStatus.NOT_FOUND).json({
                "msg": "Error: Tags not found - " + err
            });
        });
    });

    /*
     * Adds a new tag to the tags collection if it isn't already present
     *
     * Body: a tag document, without an _id field (will be handled automatically)
     *  Example:
     *  {
     *      tag: <tag name>
     *  }
     */
    app.post('/api/tags', (req, res) => {
        tags.insertOne(req.body, (err, result) => {
            if (err) {
                return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
                    "msg": "Error: Internal Server Error - " + err
                });
            }
            
            return res.status(HttpStatus.OK).json({
                "msg": "Successfully inserted tag " + req.body.tag
            });
        });
    });

    // ---------------------- Start Server ------------------------------------
    app.listen(process.env.PORT || 5000, function() {
        let address = this.address();
        let service = packageConfig.name + ' version: ' + packageConfig.version + ' ';
        console.log('%s Listening on %d', service, address.port);
    });
}).catch(err => console.error(err));
