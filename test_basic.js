const { expect } = require('chai');
const { query, queryBind, Session } = require(".");

describe('chDB Queries', function () {

    it('should return version, greeting message, and chdb() using standalone query', function () {
        const ret = query("SELECT version(), 'Hello chDB', chdb()", "CSV");
        console.log("Standalone Query Result:", ret);
        expect(ret).to.be.a('string');
        expect(ret).to.include('Hello chDB');
    });

    it('should return empty string when querying a non-existent table', function () {
        const ret = query("SELECT * FROM non_existent_table;", "CSV");
        expect(ret).to.equal('');
    });

    it('should return version, greeting message, and chDB() using bind query', () => {
          const ret = queryBind("SELECT version(), 'Hello chDB', chDB()", {}, "CSV");
          console.log("Bind Query Result:", ret);
          expect(ret).to.be.a('string');
          expect(ret).to.include('Hello chDB');
    });

    it('binds a numeric parameter (stand-alone query)', () => {
         const out = queryBind('SELECT {id:UInt32}', { id: 42 }, 'CSV').trim();
         console.log(out)
         expect(out).to.equal('42');
    });

    it('binds a string parameter (stand-alone query)', () => {
        const out = queryBind(
          `SELECT concat('Hello ', {name:String})`,
          { name: 'Alice' },
          'CSV'
         ).trim();
        console.log(out)
        expect(out).to.equal('"Hello Alice"');
    });

    it('binds Date and Map correctly', () => {
        const res = queryBind("SELECT {t: DateTime} AS t, {m: Map(String, Array(UInt8))} AS m",
          {
            t: new Date('2025-05-29T12:00:00Z'),
            m: { "abc": Uint8Array.from([1, 2, 3]) }
          },
          'JSONEachRow'
        );
        const row = JSON.parse(res.trim());
        expect(row.t).to.equal('2025-05-29 12:00:00');
        expect(row.m).to.deep.equal({ abc: [1, 2, 3] });
    });

    describe('Session Queries', function () {
        let session;

        before(function () {
            // Delete existing directory and create a new session instance
            const fs = require('fs');
            const path = require('path');
            const tmpDir = "./chdb-node-tmp";

            if (fs.existsSync(tmpDir)) {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }

            session = new Session(tmpDir);
        });

        after(function () {
            // Clean up the session after all tests are done
            session.cleanup();
        });

        it('should return a simple query result from session', function () {
            const ret = session.query("SELECT 123", "CSV");
            console.log("Session Query Result:", ret);
            expect(ret).to.be.a('string');
            expect(ret).to.include('123');
        });

        it('should create database and table, then insert and query data', function () {
            session.query("CREATE DATABASE IF NOT EXISTS testdb;" +
                "CREATE TABLE IF NOT EXISTS testdb.testtable (id UInt32) ENGINE = MergeTree() ORDER BY id;");

            session.query("USE testdb; INSERT INTO testtable VALUES (1), (2), (3);");

            const ret = session.query("SELECT * FROM testdb.testtable;", "CSV");
            console.log("Session Query Result:", ret);
            expect(ret).to.be.a('string');
            expect(ret).to.include('1');
            expect(ret).to.include('2');
            expect(ret).to.include('3');
        });

        it('should throw an error when querying a non-existent table', function () {
            expect(() => {
                session.query("SELECT * FROM non_existent_table;", "CSV");
            }).to.throw(Error, /Unknown table expression identifier/);
        });

        it('should throw an error when using queryBind with session', () => {
          expect(() => {
            session.queryBind("SELECT * from testdb.testtable where id > {id: UInt32}", { id: 2}, "CSV");
          }).to.throw(Error, /QueryBind is not supported with connection-based sessions. Please use the standalone queryBind function instead./);
        })
    });

});

