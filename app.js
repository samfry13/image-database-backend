const express = require('express');
const HttpStatus = require('http-status-codes');
const morgan = require('morgan');
const bodyParser = require('body-parser');
const packageConfig = require('./package.json');
const path = require('path');
const fs = require('fs');
const Busboy = require('busboy');
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
    const db = client.db("image-database");
    const images = db.collection("images");
    const tags = db.collection("tags");

    app.use(morgan('combined'));
    app.use('/api/files/images', express.static('images'));
    app.use(bodyParser.json());
    app.use(bodyParser.urlencoded({ extended: false }));

    app.get('/api', (req, res) => {
        return res.status(HttpStatus.OK).json({
            msg: 'OK',
            service: 'Image Database API Server'
        });
    });

    // ---------------------- Database Operations ------------------------------------
    app.get('/api/image/db', (req, res) => {
        images.findOne({_id: req.query.id}, (err, result) => {
            if (err) {
                console.error(err);
                return res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(err);
            }

            if (result == null) {
                return res.status(HttpStatus.NOT_FOUND).end();
            }

            console.log("Mongo Get Image - _id=" + req.query.id);
            return res.status(HttpStatus.OK).json(result);
        });
    });

    app.post('/api/image/db', (req, res) => {
        images.insertOne(req.body, (err, result) => {
            if (err) {
                if (err.code == 11000) {
                    return res.status(409).json({
                        "msg": "Error: Record Already Exists at id=" + req.body._id
                    });
                }

                console.error(err);
                return res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(err);
            }

            console.log("Mongo Insert Image - _id=" + result.insertedId);
            return res.status(HttpStatus.OK).end();
        });
    });

    app.put('/api/image/db', (req, res) => {
        images.updateOne({_id: req.body["_id"]}, req.body, (err, result) => {
            if (err) {
                console.error(err);
                return res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(err);
            }

            console.log("Mongo Update Image - _id=" + result.upsertedId);
            return res.status(HttpStatus.OK).end();
        });
    });

    app.delete('/api/image/db', (req, res) => {
        images.deleteOne(req.body, (err, result) => {
            if (err) {
                console.error(err);
                return res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(err);
            }
            
            if (result.deletedCount == 0) {
                return res.status(HttpStatus.NOT_FOUND).end();
            }

            console.log("Mongo Delete Image - _id=" + req.body._id);
            return res.status(HttpStatus.OK).end();
        });
    });

    // ---------------------- Storage Operations ------------------------------------
    app.delete('/api/image/storage', (req, res) => {
        fs.unlink(path.join(__dirname, 'images', path.basename(req.query.file)), (err) => {
            if (err) {
                if (err.code == "ENOENT") {
                    return res.status(HttpStatus.NOT_FOUND).end();
                }

                console.error(err);
                return res.status(HttpStatus.INTERNAL_SERVER_ERROR).end();
            }

            console.log("Deleted File - " + req.query.file);
            return res.status(HttpStatus.OK).end();
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
                url: filePath
            }));
            res.end();
        });
        return req.pipe(busboy);
    });

    // ---------------------- Tags Operations ------------------------------------
    app.get('/api/tags', (req, res) => {
        tags.find().toArray().then(items => {
            res.status(HttpStatus.OK).json(items);
        }).catch(err => {
            res.status(HttpStatus.NOT_FOUND).end();
        });
    });

    app.post('/api/tags', (req, res) => {
        
    });

    // ---------------------- Start Server ------------------------------------
    app.listen(process.env.PORT || 5000, function() {
        let address = this.address();
        let service = packageConfig.name + ' version: ' + packageConfig.version + ' ';
        console.log('%s Listening on %d', service, address.port);
    });
}).catch(err => console.error(err));