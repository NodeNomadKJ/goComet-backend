import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { KAFKA_TOPICS, PaymentStatus } from '@gocomet/common';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import { PaymentEntity } from './entities/payment.entity';
import { WebhookDto } from './dto/webhook.dto';

@Injectable()
export class PaymentService {
  constructor(
    @InjectRepository(PaymentEntity) private readonly paymentRepo: Repository<PaymentEntity>,
    private readonly kafkaProducer: KafkaProducerService,
  ) {}

  async getPayment(paymentId: string, tenantId: string, requesterId: string): Promise<PaymentEntity> {
    const payment = await this.paymentRepo.findOne({ where: { id: paymentId, tenantId } });
    if (!payment) throw new NotFoundException(`Payment ${paymentId} not found`);
    if (payment.riderId !== requesterId) throw new NotFoundException(`Payment ${paymentId} not found`);
    return payment;
  }

  async getPaymentByTrip(tripId: string, tenantId: string): Promise<PaymentEntity | null> {
    return this.paymentRepo.findOne({ where: { tripId, tenantId } });
  }

  async handleWebhook(tenantId: string | undefined, body: WebhookDto): Promise<void> {
    const payment = await this.paymentRepo.findOne({
      where: body.pspReference
        ? { pspReference: body.pspReference, ...(tenantId ? { tenantId } : {}) }
        : { id: body.paymentId, ...(tenantId ? { tenantId } : {}) },
    });

    if (!payment) return;

    if (body.status === 'success') {
      payment.status = PaymentStatus.COMPLETED;
      payment.pspReference = body.pspReference;
      payment.processedAt = new Date();
      await this.paymentRepo.save(payment);

      await this.kafkaProducer.emit(
        KAFKA_TOPICS.PAYMENT_CHARGE_COMPLETED,
        { paymentId: payment.id, tripId: payment.tripId, pspReference: body.pspReference },
        payment.tenantId,
        payment.regionId,
        payment.tripId,
      );
    } else {
      payment.status = PaymentStatus.FAILED;
      payment.failureReason = body.failureReason ?? 'Unknown failure';
      await this.paymentRepo.save(payment);

      await this.kafkaProducer.emit(
        KAFKA_TOPICS.PAYMENT_CHARGE_FAILED,
        { paymentId: payment.id, tripId: payment.tripId, failureReason: payment.failureReason },
        payment.tenantId,
        payment.regionId,
        payment.tripId,
      );
    }
  }
}
