import { Inject } from '@nestjs/common';
import { REDIS_CLIENT } from './redis.constants';

export const InjectRedis = (): ReturnType<typeof Inject> => Inject(REDIS_CLIENT);
