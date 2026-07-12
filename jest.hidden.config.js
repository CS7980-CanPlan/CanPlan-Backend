/** @type {import('ts-jest').JestConfigWithTsJest} */
// Runs ONLY the issue-43 hidden tests (kept outside the default jest `roots` in
// jest.config.js, so `npm test` never picks them up). Invoke with:
//   npx jest --config jest.hidden.config.js
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests-hidden'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
};
