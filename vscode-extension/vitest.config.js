"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const config_1 = require("vitest/config");
exports.default = (0, config_1.defineConfig)({
    test: {
        globals: true,
        environment: 'node',
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            include: ['src/**/*.ts'],
            exclude: ['src/test/**', 'src/**/*.test.ts'],
            lines: 80,
            functions: 80,
            branches: 80,
            statements: 80
        }
    }
});
//# sourceMappingURL=vitest.config.js.map