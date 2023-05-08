//const chdb = require('./build/chdb.node');
const chdb = require('node-gyp-build')(__dirname)
module.exports = chdb;
