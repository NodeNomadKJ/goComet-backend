# /implement-notifications

Implement the event-driven notification system. Notifications are NEVER sent inline.
All channels: push (FCM), SMS (Twilio), email (SES/Nodemailer). Prerequisite: Kafka events.

## What to Build

### File Structure

```
apps/worker/src/modules/notification/
  notification.module.ts
  consumers/
    push.consumer.ts          ← notification.push.requested
    sms.consumer.ts           ← notification.sms.requested
    email.consumer.ts         ← notification.email.requested
  channels/
    fcm.channel.ts            ← Firebase Cloud Messaging
    twilio.channel.ts         ← SMS
    ses.channel.ts            ← Email (AWS SES / Nodemailer)
  templates/
    push.templates.ts         ← all push notification templates
    sms.templates.ts
  services/
    notification-preference.service.ts
  entities/
    notification.entity.ts    ← delivery log

apps/api/src/modules/notification/
  notification.controller.ts  ← GET /riders/me/notifications
```

### NotificationEntity (delivery log)

```typescript
@Entity('notifications')
@Index(['tenantId', 'userId', 'createdAt'])
export class NotificationEntity extends BaseEntity {
  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'enum', enum: NotificationChannel })
  channel: NotificationChannel;  // PUSH | SMS | EMAIL

  @Column({ type: 'enum', enum: NotificationType })
  type: NotificationType;

  @Column({ type: 'text' })
  title: string;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'enum', enum: NotificationStatus })
  status: NotificationStatus;  // PENDING | SENT | FAILED

  @Column({ nullable: true })
  providerMessageId: string;  // FCM message ID, Twilio SID, etc.

  @Column({ nullable: true })
  failureReason: string;

  @Column({ default: 0 })
  attemptCount: number;

  @Column({ type: 'jsonb', nullable: true })
  data: Record<string, unknown>;  // deep link data for push
}
```

### NotificationType Enum

```typescript
export enum NotificationType {
  // Ride events
  DRIVER_ASSIGNED       = 'DRIVER_ASSIGNED',
  DRIVER_ARRIVING       = 'DRIVER_ARRIVING',
  DRIVER_ARRIVED        = 'DRIVER_ARRIVED',
  RIDE_STARTED          = 'RIDE_STARTED',
  RIDE_COMPLETED        = 'RIDE_COMPLETED',
  RIDE_CANCELLED        = 'RIDE_CANCELLED',
  MATCHING_FAILED       = 'MATCHING_FAILED',

  // Payment
  PAYMENT_COMPLETED     = 'PAYMENT_COMPLETED',
  PAYMENT_FAILED        = 'PAYMENT_FAILED',
  PAYMENT_RECEIPT       = 'PAYMENT_RECEIPT',

  // Account
  OTP                   = 'OTP',
  PASSWORD_RESET        = 'PASSWORD_RESET',
  ACCOUNT_VERIFIED      = 'ACCOUNT_VERIFIED',

  // Driver-specific
  NEW_RIDE_OFFER        = 'NEW_RIDE_OFFER',
  EARNINGS_SUMMARY      = 'EARNINGS_SUMMARY',
}
```

### Push Notification Templates

```typescript
// templates/push.templates.ts
export const PUSH_TEMPLATES: Record<NotificationType, (data: Record<string, string>) => PushTemplate> = {
  [NotificationType.DRIVER_ASSIGNED]: (data) => ({
    title: 'Driver Found!',
    body: `${data.driverName} is on the way. ETA: ${data.etaMinutes} min`,
    data: { screen: 'ActiveRide', rideId: data.rideId },
  }),
  [NotificationType.DRIVER_ARRIVED]: (data) => ({
    title: 'Your driver has arrived',
    body: `${data.driverName} is waiting at ${data.pickupAddress}`,
    data: { screen: 'ActiveRide', rideId: data.rideId },
  }),
  [NotificationType.RIDE_COMPLETED]: (data) => ({
    title: 'Ride Completed',
    body: `You've arrived! Fare: ${data.currency} ${data.amount}`,
    data: { screen: 'TripSummary', tripId: data.tripId },
  }),
  [NotificationType.PAYMENT_COMPLETED]: (data) => ({
    title: 'Payment Successful',
    body: `${data.currency} ${data.amount} paid via ${data.method}`,
    data: { screen: 'Receipt', paymentId: data.paymentId },
  }),
  // ... all types
};
```

### FCM Channel

```typescript
@Injectable()
export class FcmChannel {
  private app: admin.app.App;

  constructor(config: ConfigService) {
    this.app = admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(config.get('FIREBASE_SERVICE_ACCOUNT'))),
    });
  }

  async send(token: string, template: PushTemplate): Promise<{ messageId: string }> {
    const message: admin.messaging.Message = {
      token,
      notification: { title: template.title, body: template.body },
      data: template.data as Record<string, string>,
      android: { priority: 'high' },
      apns: { payload: { aps: { sound: 'default', badge: 1 } } },
    };
    const messageId = await this.app.messaging().send(message);
    return { messageId };
  }

  async sendMulticast(tokens: string[], template: PushTemplate) {
    return this.app.messaging().sendEachForMulticast({
      tokens,
      notification: { title: template.title, body: template.body },
      data: template.data as Record<string, string>,
    });
  }
}
```

### PushConsumer

```typescript
@Injectable()
export class PushConsumer extends BaseConsumer<PushNotificationPayload> {
  protected readonly topic = KAFKA_TOPICS.NOTIFICATION_PUSH_REQUESTED;
  protected readonly consumerGroup = 'gocomet-push-notification-consumer';

  protected async handle(event: DomainEvent<PushNotificationPayload>): Promise<void> {
    const { userId, type, data, tenantId } = event.payload;

    // Check user preferences — skip if push disabled for this type
    const prefs = await this.notificationPrefService.getPreferences(userId, tenantId);
    if (!prefs.push[type]) {
      this.logger.debug({ userId, type }, 'Push notification skipped by user preference');
      return;
    }

    // Get FCM device tokens for user (can have multiple devices)
    const tokens = await this.deviceTokenService.getTokens(userId, tenantId);
    if (!tokens.length) return;

    const template = PUSH_TEMPLATES[type](data);

    // Log to DB first (PENDING status)
    const notification = await this.notificationRepo.save({
      tenantId, userId,
      channel: NotificationChannel.PUSH,
      type, title: template.title, body: template.body,
      status: NotificationStatus.PENDING, data,
    });

    try {
      const result = await this.fcmChannel.sendMulticast(tokens, template);
      await this.notificationRepo.update(notification.id, {
        status: NotificationStatus.SENT,
        attemptCount: 1,
      });
    } catch (err) {
      await this.notificationRepo.update(notification.id, {
        status: NotificationStatus.FAILED,
        failureReason: err.message,
        attemptCount: 1,
      });
      throw err;  // re-throw to trigger BaseConsumer retry
    }
  }
}
```

### NotificationPreferenceService

```typescript
@Injectable()
export class NotificationPreferenceService {
  async getPreferences(userId: string, tenantId: string): Promise<NotificationPreferences> {
    // Cache in Redis: prefs:{userId} TTL 10min
    const cached = await this.redis.get(`prefs:${userId}`);
    if (cached) return JSON.parse(cached);

    const rider = await this.riderRepo.findOne({ where: { userId, tenantId } });
    const prefs = rider?.preferences?.notifications ?? this.getDefaultPreferences();

    await this.redis.set(`prefs:${userId}`, JSON.stringify(prefs), 'EX', 600);
    return prefs;
  }

  private getDefaultPreferences(): NotificationPreferences {
    return {
      push: Object.fromEntries(Object.values(NotificationType).map(t => [t, true])),
      sms: {
        [NotificationType.OTP]: true,
        [NotificationType.RIDE_COMPLETED]: true,
        [NotificationType.PAYMENT_COMPLETED]: true,
      },
      email: {
        [NotificationType.PAYMENT_RECEIPT]: true,
        [NotificationType.PASSWORD_RESET]: true,
      },
    };
  }
}
```

### Events That Trigger Notifications

Wire these consumers to emit `notification.push.requested`:

| Kafka Topic | Notification Type | Target User |
|---|---|---|
| driver.assignment.created | DRIVER_ASSIGNED | Rider |
| trip.status.changed (DRIVER_ARRIVING) | DRIVER_ARRIVING | Rider |
| trip.status.changed (DRIVER_ARRIVED) | DRIVER_ARRIVED | Rider |
| trip.status.changed (RIDE_STARTED) | RIDE_STARTED | Rider |
| trip.completed | RIDE_COMPLETED | Rider |
| payment.charge.completed | PAYMENT_COMPLETED | Rider |
| ride.matching.failed | MATCHING_FAILED | Rider |
| ride.request.created | NEW_RIDE_OFFER | Driver (already handled in Socket.IO, push as fallback) |

### API Endpoint

```typescript
@Get('riders/me/notifications')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.RIDER)
async getNotifications(
  @CurrentUser() user: JwtPayload,
  @Query('page') page = 1,
  @Query('limit') limit = 20,
) {
  return this.notificationService.getUserNotifications(user.sub, user.tenantId, { page, limit });
}
```

### Unit Tests

```typescript
describe('PushConsumer', () => {
  it('skips if user has disabled this notification type')
  it('skips if no device tokens')
  it('logs PENDING before sending')
  it('updates to SENT on success')
  it('updates to FAILED and re-throws on FCM error (to trigger retry)')
})

describe('NotificationPreferenceService', () => {
  it('returns from Redis cache when available')
  it('defaults all push notifications to enabled')
  it('invalidates cache when preferences updated')
})
```

## Update Progress

Check off all Notification items in PROJECT_PROGRESS.md.
Mark Phase 4 complete when Kafka + Payment + Notifications all done.
