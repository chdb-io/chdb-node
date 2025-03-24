const { expect } = require('chai');
const { query, Session, Connect } = require(".");

describe('chDB Queries', function () {

    it('should return version, greeting message, and chdb() using standalone query', function () {
        const ret = query("SELECT version(), 'Hello chDB', chdb()", "CSV");
        console.log("Standalone Query Result:", ret);
        expect(ret).to.be.a('string');
        expect(ret).to.include('Hello chDB');
    });

    it('should throw an error when querying a non-existent table', function () {
        expect(() => {
            query("SELECT * FROM non_existent_table;", "CSV");
        }).to.throw(Error, /Unknown table expression identifier/);
    });

    describe('Session Queries', function () {
        let session;

        before(function () {
            // Create a new session instance before running the tests
            session = new Session("");
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

            const ret = session.query("SELECT * FROM testtable;", "CSV");
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
    });


    describe('Connect Queries in memory', function () {
        let session;

        before(function () {
            // Create a new session instance before running the tests
            session = new Connect();
        });

        after(function () {
            // Clean up the session after all tests are done
            session.cleanup();
        });

        it('should return a simple query result from session', function () {
            const ret = session.query("SELECT 123", "CSV");
            console.log("Session Query Result:", ret);

            expect(ret.getBuffer()).to.be.instanceOf(Buffer);
            expect(ret.getBuffer().toString()).to.include('123');
        });

        it('should create database and table, then insert and query data', function () {
            session.query("CREATE TABLE IF NOT EXISTS testtable (id UInt32) ENGINE = Memory");    
            session.query("INSERT INTO testtable VALUES (1), (2), (3);");
            
            const ret = session.query("SELECT * FROM testtable;", "CSV");
            console.log("Session Query Result:", ret);
            expect(ret.getBuffer()).to.be.instanceOf(Buffer);
            let retString = ret.getBuffer().toString();
            expect(retString).to.include('1');
            expect(retString).to.include('2');
            expect(retString).to.include('3');
        });

        it('should throw an error when querying a non-existent table', function () {
            expect(() => {
                session.query("SELECT * FROM non_existent_table;", "CSV");
            }).to.throw(Error, /Unknown table expression identifier/);
        });
    });
});

