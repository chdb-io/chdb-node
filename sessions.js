const addon = require(".");
var res;

addon.Session(
  "CREATE DATABASE IF NOT EXISTS db_xxx Engine=Atomic;",
  "CSV",
  "."
);

addon.Session(
  "CREATE TABLE IF NOT EXISTS db_xxx.log_table_xxx (x String, y Int) ENGINE = Log;",
  "CSV",
  "."
);

addon.Session(
  "INSERT INTO db_xxx.log_table_xxx VALUES ('a', 1), ('b', 3), ('c', 2), ('d', 5);",
  "CSV",
  "."
);

res = addon.Session(
  "SELECT * FROM db_xxx.log_table_xxx LIMIT 4;",
  "Pretty",
  "."
);

console.log(res);
