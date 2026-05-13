import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ServerResponse } from 'node:http';
import type { FastifyRequest, FastifyReply } from 'fastify';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<FastifyRequest>();
    const reply = ctx.getResponse<FastifyReply | ServerResponse>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const correlationId = request.headers['x-correlation-id'] as string | undefined;

    if (status >= 500) {
      this.logger.error(
        {
          correlationId,
          status,
          path: request.url,
          method: request.method,
          err: exception instanceof Error ? exception.message : String(exception),
          stack: exception instanceof Error ? exception.stack : undefined,
        },
        'Unhandled exception',
      );
    } else if (status >= 400 && process.env.NODE_ENV !== 'production') {
      this.logger.warn(
        {
          correlationId,
          status,
          method: request.method,
          path: request.url,
          err: exception instanceof HttpException ? exception.message : String(exception),
        },
        'Client error',
      );
    }

    const message =
      status >= 500
        ? 'Internal server error'
        : exception instanceof HttpException
          ? ((exception.getResponse() as Record<string, unknown>).message ?? exception.message)
          : 'An error occurred';

    const body = JSON.stringify({ statusCode: status, message, correlationId, timestamp: new Date().toISOString() });

    // Fastify reply has .status(); raw Node ServerResponse has .statusCode
    if (typeof (reply as FastifyReply).status === 'function') {
      void (reply as FastifyReply).status(status).send({ statusCode: status, message, correlationId, timestamp: new Date().toISOString() });
    } else {
      const raw = reply as ServerResponse;
      raw.statusCode = status;
      raw.setHeader('Content-Type', 'application/json');
      raw.end(body);
    }
  }
}
