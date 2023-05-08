const addon = require('.');
var result = addon.Execute('SELECT version()', 'TabSeparated');
console.log(result)
