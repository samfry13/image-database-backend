const express = require("express");
const HttpStatus = require("http-status-codes");
const morgan = require("morgan");
const bodyParser = require("body-parser");
const fileUpload = require("express-fileupload");
const packageConfig = require("./package.json");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

// Set up mongo
const mongoUsername = process.env.MONGO_USERNAME;
const mongoPassword = process.env.MONGO_PASSWORD;
const mongoHost = process.env.MONGO_HOST || "localhost";
const mongoPort = process.env.MONGO_PORT || 27017;
const MongoClient = require("mongodb").MongoClient;
const mongoURL = `mongodb://${mongoUsername}:${mongoPassword}@${mongoHost}:${mongoPort}/?authSource=image-database`;

// Set up host
const hostname = process.env.HOSTNAME || "localhost";

const sessionSecret = process.env.SESSION_SECRET || "super secret";

const app = express();
MongoClient.connect(mongoURL, { useUnifiedTopology: true })
    .then((client) => {
        console.log("Connected to Database");
        const db = client.db("image-database");
        const images = db.collection("images");
        const tags = db.collection("tags");
        const users = db.collection("users");

        app.use(morgan("dev"));
        app.use("/api/files/images", express.static("images"));
        app.use(bodyParser.json());
        app.use(bodyParser.urlencoded({ extended: false }));
        app.use(fileUpload());
        app.use(cors({ origin: true }));

        /*
         * A simple API Health Check
         */
        app.get("/api", (req, res) => {
            return res.status(HttpStatus.OK).json({
                msg: "OK",
                service: "Image Database API Server",
            });
        });

        // ---------------------- Authentication Operations ------------------------------
        // Note: There will not be any signup functionality as I only need 1 user to be able
        // to login, and so I won't need to be able to make a new user.

        /*
         * Authentication middleware for verifying and decrypting jwt tokens. Calls
         * next() when done
         *
         * Header: token - A JWT token signed from this server
         *
         * @returns {json} an error if it exists. Otherwise nothing.
         */
        const auth = (req, res, next) => {
            const token = req.header("token");
            if (!token) {
                return res.status(HttpStatus.UNAUTHORIZED).json({
                    error: true,
                    msg: "Error: Authentication Error",
                });
            }

            try {
                const decoded = jwt.verify(token, sessionSecret);
                req.user = decoded.user;
                next();
            } catch (err) {
                res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
                    error: true,
                    msg: "Error: Internal Server Error - " + err,
                });
            }
        };

        /*
         * Checks if a user can login, and returns a session token for authencating
         * certain endpoints
         *
         * Body: A JSON object with the user credentials
         *  Example:
         *  {
         *      email: <email>,
         *      password: <password>
         *  }
         *
         * @returns {json} an object with a token key, or an object describing an error
         */
        app.post("/api/auth/login", (req, res) => {
            const { email, password } = req.body;
            console.log(email, password);
            users.findOne({ email }, (err, result) => {
                if (err) {
                    return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
                        error: true,
                        msg: "Error: Internal Server Error - " + err,
                    });
                }

                if (result === null) {
                    return res.status(HttpStatus.NOT_FOUND).json({
                        error: true,
                        msg: "Error: User Not Found",
                    });
                }

                bcrypt.compare(password, result.passwordHash, (err, match) => {
                    if (err) {
                        return res
                            .status(HttpStatus.INTERNAL_SERVER_ERROR)
                            .json({
                                error: true,
                                msg: "Error: Internal Server Error - " + err,
                            });
                    }

                    if (match) {
                        jwt.sign(
                            {
                                user: {
                                    email: result.email,
                                    name: result.name,
                                },
                            },
                            sessionSecret,
                            { expiresIn: "7 days" },
                            (err, token) => {
                                if (err) {
                                    return res
                                        .status(
                                            HttpStatus.INTERNAL_SERVER_ERROR
                                        )
                                        .json({
                                            error: true,
                                            msg:
                                                "Error: Internal Server Error - " +
                                                err,
                                        });
                                }

                                return res.status(HttpStatus.OK).json({
                                    msg: "Successfully logged in",
                                    token,
                                    user: {
                                        email: result.email,
                                        name: result.name,
                                    },
                                });
                            }
                        );
                    } else {
                        return res.status(HttpStatus.UNAUTHORIZED).json({
                            error: true,
                            msg: "Error: Credentials are incorrect",
                        });
                    }
                });
            });
        });

        /*
         * Verifies a session and issues a new JWT token
         */
        app.get("/api/auth/session", auth, (req, res) => {
            jwt.sign(
                { user: req.user },
                sessionSecret,
                { expiresIn: "7 days" },
                (err, token) => {
                    if (err) {
                        return res
                            .status(HttpStatus.INTERNAL_SERVER_ERROR)
                            .json({
                                error: true,
                                msg: "Error: Internal Server Error - " + err,
                            });
                    }

                    return res.status(HttpStatus.OK).json({
                        msg: "Valid Session",
                        token,
                        user: req.user,
                    });
                }
            );
        });

        // ---------------------- Database Operations ------------------------------------

        /*
         * Get number of pages in images collection based on pageSize and search query
         *
         * Query Parameters:
         *  pageSize => size of querying page. Default 15, like the /api/image/db endpoint
         *  search => search query
         *  tags => array of tags as a query
         */
        app.get("/api/image/db/pages", (req, res) => {
            let search = req.query.search || ".*";
            let tags = req.query.tags || [];
            tags = Array.isArray(tags) ? tags : [tags];
            images.countDocuments(
                {
                    tags: tags.length ? { $all: tags } : { $in: [/.*/] },
                    $or: [
                        { title: { $regex: `${search}`, $options: "i" } },
                        { description: { $regex: `${search}`, $options: "i" } },
                    ],
                },
                (err, result) => {
                    if (err) {
                        return res
                            .status(HttpStatus.INTERNAL_SERVER_ERROR)
                            .json({
                                error: true,
                                msg: "Error: Internal Server Error - " + err,
                            });
                    }

                    let pageSize = req.query.pageSize || 15;
                    let pages = Math.ceil(result / pageSize);
                    return res.status(HttpStatus.OK).json(pages);
                }
            );
        });

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
         *  search => a query string for searching titles or descriptions
         *  tags => an array of tags to query
         *
         * @returns {json} sends a json array for many objects and just one object for a single id query
         */
        app.get("/api/image/db", (req, res) => {
            if (req.query.id) {
                images.findOne({ _id: req.query.id }, (err, result) => {
                    if (err) {
                        console.error(err);
                        return res
                            .status(HttpStatus.INTERNAL_SERVER_ERROR)
                            .json({
                                error: true,
                                msg: "Error: Internal Server Error - " + err,
                            });
                    }

                    if (result == null) {
                        return res.status(HttpStatus.NOT_FOUND).json({
                            error: true,
                            msg: "Error: Not Found",
                        });
                    }

                    return res.status(HttpStatus.OK).json(result);
                });
            } else {
                let pageSize = parseInt(req.query.pageSize) || 15;
                let pageNum = parseInt(req.query.pageNum) || 1;
                let skipAmount = pageSize * (pageNum - 1);
                let search = req.query.search || ".*";
                let tags = req.query.tags || [];
                tags = Array.isArray(tags) ? tags : [tags];
                images
                    .find(
                        {
                            tags: tags.length
                                ? { $all: tags }
                                : { $in: [/.*/] },
                            $or: [
                                {
                                    title: {
                                        $regex: `${search}`,
                                        $options: "i",
                                    },
                                },
                                {
                                    description: {
                                        $regex: `${search}`,
                                        $options: "i",
                                    },
                                },
                            ],
                        },
                        { skip: skipAmount, limit: pageSize }
                    )
                    .toArray()
                    .then((result) => {
                        if (result == null) {
                            return res.status(HttpStatus.NOT_FOUND).json({
                                error: true,
                                msg: "Error: Not Found",
                            });
                        }

                        return res.status(HttpStatus.OK).json(result);
                    })
                    .catch((err) => {
                        console.error(err);
                        return res
                            .status(HttpStatus.INTERNAL_SERVER_ERROR)
                            .json({
                                error: true,
                                msg: "Error: Internal Server Error - " + err,
                            });
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
         *      createdAt: <timestamp>,
         *      description: <description of image>,
         *      filePath: <URL returned from /api/image/storage endpoint>,
         *      tags: <array of tag strings from tags collection>,
         *      title: <title of image>,
         *      updatedAt: <timestamp>
         *  }
         *
         * @returns {json} a message whether or not the operation was successful or not
         */
        app.post("/api/image/db", auth, (req, res) => {
            images.insertOne(req.body, (err, result) => {
                if (err) {
                    if (err.code == 11000) {
                        return res.status(409).json({
                            error: true,
                            msg:
                                "Error: Record Already Exists at id=" +
                                req.body._id,
                        });
                    }

                    console.error(err);
                    return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
                        error: true,
                        msg: "Error: Internal Server Error - " + err,
                    });
                }

                return res.status(HttpStatus.OK).json({
                    msg: "Successfully added image _id=" + result.insertedId,
                });
            });
        });

        /*
         * Updates an image in the database
         *
         * Body: a document to be updated in the images collection.
         *  Example:
         *  {
         *      _id: <unique-id of an existing image>,
         *      createdAt: <timestamp>,
         *      description: <description of image>,
         *      filePath: <URL returned from /api/image/storage endpoint>,
         *      tags: <array of tag strings from tags collection>,
         *      title: <title of image>,
         *      updatedAt: <timestamp>
         *  }
         *
         * @returns {json} a message whether or not the operation was successful or not
         */
        app.put("/api/image/db", auth, (req, res) => {
            images.updateOne(
                { _id: req.body["_id"] },
                req.body,
                (err, result) => {
                    if (err) {
                        console.error(err);
                        return res
                            .status(HttpStatus.INTERNAL_SERVER_ERROR)
                            .json({
                                error: true,
                                msg: "Error: Internal Server Error - " + err,
                            });
                    }

                    return res.status(HttpStatus.OK).json({
                        msg:
                            "Successfully updated image _id=" +
                            result.upsertedId,
                    });
                }
            );
        });

        /*
         * Deletes an image in the database
         *
         * Body: a document to be deleted from the images collection.
         *  Example:
         *  {
         *      _id: <unique-id>
         *  }
         *
         * @returns {json} a message whether or not the operation was successful or not
         */
        app.delete("/api/image/db", auth, (req, res) => {
            images.deleteOne(req.body, (err, result) => {
                if (err) {
                    console.error(err);
                    return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
                        error: true,
                        msg: "Error Internal Server Error - " + err,
                    });
                }

                if (result.deletedCount == 0) {
                    return res.status(HttpStatus.NOT_FOUND).json({
                        error: true,
                        msg: "Error: Image not found",
                    });
                }

                return res.status(HttpStatus.OK).json({
                    msg: "Successfully deleted image _id=" + req.body._id,
                });
            });
        });

        // ---------------------- Storage Operations ------------------------------------

        app.post("/api/image/storage", auth, (req, res) => {
            if (!req.files || Object.keys(req.files).length === 0) {
                return res.status(HttpStatus.BAD_REQUEST).json({
                    error: true,
                    msg: "Error: No files uploaded",
                });
            }

            let image = req.files.image;
            let filePath = `${hostname}/api/files/images/` + image.name;

            // Move the image to the images folder in /images/filename
            image.mv(path.join(__dirname, "images", image.name), (err) => {
                if (err) {
                    return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
                        error: true,
                        msg: "Error: Internal Server Error - " + err,
                    });
                }

                return res.status(HttpStatus.OK).json({
                    msg: "Successfully uploaded file - " + image.name,
                    url: filePath,
                });
            });
        });

        /*
         * Deletes an image from storage
         *
         * Body:
         *  Example:
         *  {
         *      _id: <unique-id>
         *  }
         *
         * @returns {json} a message whether or not the operation was successful or not
         */
        app.delete("/api/image/storage", auth, (req, res) => {
            fs.unlink(
                path.join(__dirname, "images", path.basename(req.query.file)),
                (err) => {
                    if (err) {
                        if (err.code == "ENOENT") {
                            return res.status(HttpStatus.NOT_FOUND).json({
                                error: true,
                                msg: "Error: Image not found",
                            });
                        }

                        console.error(err);
                        return res
                            .status(HttpStatus.INTERNAL_SERVER_ERROR)
                            .json({
                                error: true,
                                msg: "Error: Internal Server Error - " + err,
                            });
                    }

                    return res.status(HttpStatus.OK).json({
                        msg: "Successfully deleted image - " + req.query.file,
                    });
                }
            );
        });

        // ---------------------- Tags Operations ------------------------------------

        /*
         * Gets all of the tags from the tags collection
         *
         * @returns {json} a list of all of the tag documents
         */
        app.get("/api/tags", (_, res) => {
            tags.find()
                .toArray()
                .then((items) => {
                    res.status(HttpStatus.OK).json(items);
                })
                .catch((err) => {
                    res.status(HttpStatus.NOT_FOUND).json({
                        error: true,
                        msg: "Error: Tags not found - " + err,
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
         *
         * @returns {json} a success or error message
         */
        app.post("/api/tags", auth, (req, res) => {
            tags.insertOne(req.body, (err) => {
                if (err) {
                    return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
                        error: true,
                        msg: "Error: Internal Server Error - " + err,
                    });
                }

                return res.status(HttpStatus.OK).json({
                    msg: "Successfully inserted tag " + req.body.tag,
                });
            });
        });

        /*
         * Removes a tag from the tags collection, and removes it from any images
         *
         * Body: a tag document, with out an _id field.
         *  Example:
         *  {
         *      tag: <tag name>
         *  }
         *
         * @returns {json} a success or error message
         */
        app.delete("/api/tags", auth, (req, res) => {
            //tags.deleteOne(req.body, (err) => {
            //    if (err) {
            //        return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
            //           error: true,
            //            msg: "Error: Internal Server Error - " + err,
            //        });
            //    }
            //
            //
            //})
            //TODO: delete the tag from all of the images
            return res.status(200).end();
        });

        // ---------------------- Start Server ------------------------------------
        app.listen(process.env.PORT || 5000, function () {
            let address = this.address();
            let service =
                packageConfig.name + " version: " + packageConfig.version + " ";
            console.log("%s Listening on %d", service, address.port);
        });
    })
    .catch((err) => console.error(err));
