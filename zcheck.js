"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const geography_schema_1 = require("./src/reference/dto/geography.schema");
const a = geography_schema_1.ListMarkazesQuerySchema.safeParse({ page: '1', pageSize: '200', governorateId: '1' });
console.log('pageSize=200 ->', a.success ? 'OK' : 'REJECTED: ' + a.error.issues.map(i => i.path.join('.') + ' ' + i.message).join('; '));
const b = geography_schema_1.ListMarkazesQuerySchema.safeParse({ page: '1', pageSize: '100', governorateId: '1' });
console.log('pageSize=100 ->', b.success ? 'OK' : 'REJECTED');
//# sourceMappingURL=zcheck.js.map