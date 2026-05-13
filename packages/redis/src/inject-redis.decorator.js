"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InjectRedis = void 0;
const common_1 = require("@nestjs/common");
const redis_constants_1 = require("./redis.constants");
const InjectRedis = () => (0, common_1.Inject)(redis_constants_1.REDIS_CLIENT);
exports.InjectRedis = InjectRedis;
//# sourceMappingURL=inject-redis.decorator.js.map