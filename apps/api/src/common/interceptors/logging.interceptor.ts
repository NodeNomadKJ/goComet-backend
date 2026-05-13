import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import type { FastifyRequest, FastifyReply } from 'fastify';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const { method, url } = req;
    const correlationId = req.headers['x-correlation-id'] as string | undefined;
    const start = Date.now();

    return next.handle().pipe(
      tap(() => {
        const reply = context.switchToHttp().getResponse<FastifyReply>();
        const duration = Date.now() - start;
        this.logger.log({
          method,
          url,
          statusCode: reply.statusCode,
          duration,
          correlationId,
        }, `${method} ${url} ${reply.statusCode} ${duration}ms`);
      }),
    );
  }
}
