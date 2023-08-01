const { Execute } = require('..').chdb;

describe("Execution", () => {
	test('Execute returns correct version', () => {
	  const version = Execute('SELECT 1', 'CSV');
	  expect(version).toContain("1");
	});
});
