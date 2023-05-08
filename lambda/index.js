/* AWS Lambda chDB Function */
const chdb = require('chdb-node');
exports.handler = async (event, context) => {
    if(!event.query) return;
    result  = chdb.Execute(event.query, event.format || "JSONCompact");
    return result;
}
