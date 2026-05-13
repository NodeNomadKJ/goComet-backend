# /implement-payment-async

Implement fully async payment processing. Trip completion triggers the flow;
the rider never waits for PSP in the request path.
Prerequisite: Kafka events infrastructure + trip state machine complete.

## Architecture

```
trip.completed (Kafka)
       ↓
PSPConsumer
  → calls PSP (Stripe sandbox / mock)
  → on success: emit payment.charge.completed
  → on failure: retry 3x → emit payment.charge.failed

payment.charge.completed (Kafka)
       ↓
PaymentCompletionConsumer
  → update trips.payment_status = PAYMENT_COMPLETED
  → update payments table
  → emit notification.push.requested (receipt)
  → emit trip.status.changed (→ PAYMENT_COMPLETED)
```

## What to Build

### File Structure

```
apps/api/src/modules/payment/
  payment.module.ts
  payment.controller.ts      ← GET endpoints + webhook only
  payment.service.ts
  psp/
    psp.interface.ts         ← PSP abstraction
    stripe.psp.ts            ← Stripe implementation
    mock.psp.ts              ← dev/test mock
  dto/
    payment-response.dto.ts
    webhook-payload.dto.ts
  entities/
    payment.entity.ts
    payment-transaction.entity.ts
  exceptions/
    payment.exceptions.ts
  tests/
    payment.service.spec.ts
    webhook.spec.ts

apps/worker/src/consumers/
  payment-charge.consumer.ts       ← handles payment.charge.requested
  payment-completion.consumer.ts   ← handles payment.charge.completed/.failed
```

### PaymentEntity

```typescript
@Entity('payments')
@Index(['tenantId', 'regionId', 'status'])
@Index(['tripId'], { unique: true })
@Index(['idempotencyKey'], { unique: true, where: "idempotency_key IS NOT NULL" })
export class PaymentEntity extends BaseEntity {
  @Column({ type: 'uuid' })
  tripId: string;

  @Column({ type: 'uuid' })
  riderId: string;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount: number;

  @Column({ length: 3 })
  currency: string;

  @Column({ type: 'enum', enum: PaymentStatus, default: PaymentStatus.PENDING })
  status: PaymentStatus;

  @Column({ nullable: true })
  pspReference: string;     // PSP-side transaction ID

  @Column({ nullable: true })
  pspProvider: string;      // 'stripe' | 'razorpay' | 'mock'

  @Column({ nullable: true })
  failureReason: string;

  @Column({ nullable: true })
  idempotencyKey: string;

  @Column({ default: 0 })
  attemptCount: number;

  @Column({ nullable: true })
  lastAttemptAt: Date;

  @Column({ nullable: true })
  completedAt: Date;

  @Column({ nullable: true })
  refundedAt: Date;

  @Column({ nullable: true, type: 'decimal', precision: 10, scale: 2 })
  refundAmount: number;
}
```

### PSP Abstraction

```typescript
// psp/psp.interface.ts
export interface PSPChargeParams {
  amount: number;
  currency: string;
  customerId: string;       // PSP customer ID
  paymentMethodToken: string;
  idempotencyKey: string;   // critical: prevents double-charge
  metadata: Record<string, string>;
}

export interface PSPChargeResult {
  success: boolean;
  pspReference?: string;
  failureReason?: string;
  failureCode?: string;
}

export interface PSPRefundResult {
  success: boolean;
  refundReference?: string;
}

export abstract class PspService {
  abstract charge(params: PSPChargeParams): Promise<PSPChargeResult>;
  abstract refund(pspReference: string, amount: number, idempotencyKey: string): Promise<PSPRefundResult>;
  abstract verifyWebhookSignature(payload: Buffer, signature: string): boolean;
}
```

### Stripe PSP Implementation

```typescript
@Injectable()
export class StripePspService extends PspService {
  private stripe: Stripe;

  constructor(config: ConfigService) {
    super();
    this.stripe = new Stripe(config.get('STRIPE_SECRET_KEY'), { apiVersion: '2024-12-18.acacia' });
  }

  async charge(params: PSPChargeParams): Promise<PSPChargeResult> {
    try {
      const paymentIntent = await this.stripe.paymentIntents.create({
        amount: Math.round(params.amount * 100),  // cents
        currency: params.currency.toLowerCase(),
        customer: params.customerId,
        payment_method: params.paymentMethodToken,
        confirm: true,
        off_session: true,
        metadata: params.metadata,
      }, { idempotencyKey: params.idempotencyKey });

      return {
        success: paymentIntent.status === 'succeeded',
        pspReference: paymentIntent.id,
        failureReason: paymentIntent.last_payment_error?.message,
      };
    } catch (err) {
      if (err.type === 'StripeCardError') {
        return { success: false, failureCode: err.code, failureReason: err.message };
      }
      throw err;  // network/infra errors → retry in consumer
    }
  }

  verifyWebhookSignature(payload: Buffer, signature: string): boolean {
    try {
      this.stripe.webhooks.constructEvent(payload, signature, process.env.STRIPE_WEBHOOK_SECRET);
      return true;
    } catch {
      return false;
    }
  }
}
```

### PaymentChargeConsumer (apps/worker)

```typescript
@Injectable()
export class PaymentChargeConsumer extends BaseConsumer<PaymentChargeRequestedPayload> {
  protected readonly topic = KAFKA_TOPICS.PAYMENT_CHARGE_REQUESTED;
  protected readonly consumerGroup = 'gocomet-payment-charge-consumer';

  protected async handle(event: DomainEvent<PaymentChargeRequestedPayload>): Promise<void> {
    const { paymentId, tripId, riderId, amount, currency, paymentMethodToken, customerId } = event.payload;

    // Load payment — verify not already completed (defensive check beyond idempotency)
    const payment = await this.paymentRepo.findOne({ where: { id: paymentId } });
    if (payment.status === PaymentStatus.COMPLETED) return;

    await this.paymentRepo.update(paymentId, {
      status: PaymentStatus.PROCESSING,
      attemptCount: () => 'attempt_count + 1',
      lastAttemptAt: new Date(),
    });

    const result = await this.pspService.charge({
      amount, currency,
      customerId, paymentMethodToken,
      idempotencyKey: `payment:${paymentId}`,  // PSP-level idempotency
      metadata: { tripId, riderId, tenantId: event.tenantId },
    });

    if (result.success) {
      await this.kafkaProducer.emit(KAFKA_TOPICS.PAYMENT_CHARGE_COMPLETED, {
        paymentId, tripId, riderId, amount, currency,
        pspReference: result.pspReference,
      }, { tenantId: event.tenantId, regionId: event.regionId });
    } else {
      await this.kafkaProducer.emit(KAFKA_TOPICS.PAYMENT_CHARGE_FAILED, {
        paymentId, tripId, riderId,
        failureReason: result.failureReason,
        failureCode: result.failureCode,
        isRetryable: !['card_declined', 'insufficient_funds'].includes(result.failureCode ?? ''),
      }, { tenantId: event.tenantId, regionId: event.regionId });
    }
  }
}
```

### Webhook Handler (apps/api)

```typescript
@Controller('payments')
export class PaymentController {
  // Raw body needed for HMAC signature verification
  @Post('webhook')
  @HttpCode(200)
  async handleWebhook(
    @Headers('stripe-signature') signature: string,
    @Req() req: FastifyRequest,  // raw body via fastify
  ) {
    const rawBody = (req as any).rawBody as Buffer;

    if (!this.pspService.verifyWebhookSignature(rawBody, signature)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    const event = JSON.parse(rawBody.toString());

    // Idempotent: Stripe may retry webhooks
    const processed = await this.idempotencyService.getStoredResponse('webhook', event.id);
    if (processed) return { received: true };

    await this.paymentService.handleWebhookEvent(event);
    await this.idempotencyService.storeResponse('webhook', event.id, { received: true });
    return { received: true };
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  getPayment(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    return this.paymentService.getPayment(id, user.sub, user.tenantId);
  }

  @Post(':id/refund')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  initiateRefund(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    return this.paymentService.initiateRefund(id, user.tenantId);
  }
}
```

### Unit Tests

```typescript
describe('PaymentChargeConsumer', () => {
  it('skips if payment already completed')
  it('calls PSP with idempotency key = payment:{id}')
  it('emits completed event on PSP success')
  it('emits failed event on card decline (non-retryable)')
  it('throws on network error to allow BaseConsumer retry')
})

describe('PaymentController webhook', () => {
  it('returns 200 on duplicate webhook (idempotent)')
  it('returns 401 on invalid HMAC signature')
  it('delegates to payment service on valid event')
})

describe('StripePspService', () => {
  it('returns success=false on StripeCardError (not thrown)')
  it('re-throws on network/infrastructure errors')
})
```

## Update Progress

Check off all Payment Async items in PROJECT_PROGRESS.md.
