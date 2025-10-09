const { expect } = require('chai');
const { Session } = require(".");

describe('chDB Connection Tests', function () {

    describe('Session Connection Management', function () {
        let session;

        before(function () {
            // Delete existing directory and create a new session instance
            const fs = require('fs');
            const tmpDir = "./test-connection-tmp";

            if (fs.existsSync(tmpDir)) {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }

            session = new Session(tmpDir);
        });

        after(function () {
            // Clean up the session after all tests are done
            session.cleanup();
        });

        it('should create session successfully with path and connection ID', function () {
            expect(session.path).to.equal("./test-connection-tmp");
            expect(session.connection).to.not.be.null;
            expect(session.connection).to.not.be.undefined;
            console.log("✓ Session created successfully, path:", session.path);
            console.log("✓ Connection:", session.connection);
        });

        it('should execute simple query and return correct result', function () {
            const result = session.query("SELECT 1 as test_col", "CSV");
            console.log("Query result:", result.trim());
            expect(result).to.be.a('string');
            expect(result.trim()).to.equal('1');
        });

        it('should return version information', function () {
            const result = session.query("SELECT version()", "CSV");
            console.log("Version info:", result.trim());
            expect(result).to.be.a('string');
            expect(result).to.include('.');
        });

        it('should create database and table successfully', function () {
            // This should not throw an error
            expect(() => {
                session.query("CREATE DATABASE IF NOT EXISTS test_conn_db");
                session.query("CREATE TABLE IF NOT EXISTS test_conn_db.test_table (id UInt32, name String) ENGINE = MergeTree() ORDER BY id");
            }).to.not.throw();
            console.log("✓ Database and table created successfully");
        });

        it('should insert data successfully', function () {
            expect(() => {
                session.query("INSERT INTO test_conn_db.test_table VALUES (1, 'Alice'), (2, 'Bob')");
            }).to.not.throw();
            console.log("✓ Data inserted successfully");
        });

        it('should query inserted data and verify connection reuse', function () {
            const result = session.query("SELECT * FROM test_conn_db.test_table ORDER BY id", "CSV");
            console.log("Query result:", result.trim());
            expect(result).to.be.a('string');
            expect(result).to.include('Alice');
            expect(result).to.include('Bob');
            expect(result).to.include('1');
            expect(result).to.include('2');
        });

        it('should throw error when using queryBind with session', function () {
            expect(() => {
                session.queryBind("SELECT {id:UInt32}", {id: 42});
            }).to.throw(Error, /QueryBind is not supported with connection-based sessions. Please use the standalone queryBind function instead./);
            console.log("✓ queryBind correctly throws error");
        });

        it('should handle multiple queries in sequence (connection persistence)', function () {
            const result1 = session.query("SELECT COUNT(*) FROM test_conn_db.test_table", "CSV");
            const result2 = session.query("SELECT MAX(id) FROM test_conn_db.test_table", "CSV");
            const result3 = session.query("SELECT name FROM test_conn_db.test_table WHERE id = 1", "CSV");

            expect(result1.trim()).to.equal('2');
            expect(result2.trim()).to.equal('2');
            expect(result3.trim()).to.include('Alice');
            console.log("✓ Connection persistence test passed");
        });

        it('should persist data after session cleanup and reopen', function () {
            session.cleanup();

            // Create a new session with the same path
            session = new Session("./test-connection-tmp");
            session.query("USE test_conn_db")

            // Query the data to see if it persists
            const result = session.query("SELECT * FROM test_table ORDER BY id", "CSV");
            console.log("Query result after session reopen:", result.trim());

            expect(result).to.be.a('string');
            expect(result).to.include('Alice');
            expect(result).to.include('Bob');
            expect(result).to.include('1');
            expect(result).to.include('2');
            console.log("✓ Data persisted after session cleanup and reopen");
        });
    });

});
