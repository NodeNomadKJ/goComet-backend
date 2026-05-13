import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { PaymentService } from './payment.service';
import { WebhookDto } from './dto/webhook.dto';
import type { PaymentEntity } from './entities/payment.entity';

@Controller('payments')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  async getPayment(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<PaymentEntity> {
    return this.paymentService.getPayment(id, user.tenantId, user.sub);
  }

  @Post('webhook')
  async handleWebhook(@Body() body: WebhookDto): Promise<void> {
    await this.paymentService.handleWebhook(undefined, body);
  }
}
