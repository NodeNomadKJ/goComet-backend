export const KAFKA_TOPICS = {
  RIDE_REQUEST_CREATED:        'ride.request.created',
  RIDE_MATCHING_STARTED:       'ride.matching.started',
  RIDE_MATCHING_FAILED:        'ride.matching.failed',
  RIDE_REQUEST_CANCELLED:      'ride.request.cancelled',

  DRIVER_AVAILABILITY_CHANGED: 'driver.availability.changed',
  DRIVER_ASSIGNMENT_CREATED:   'driver.assignment.created',
  DRIVER_LOCATION_UPDATED:     'driver.location.updated',

  TRIP_STATUS_CHANGED:         'trip.status.changed',
  TRIP_COMPLETED:              'trip.completed',

  PAYMENT_CHARGE_REQUESTED:    'payment.charge.requested',
  PAYMENT_CHARGE_COMPLETED:    'payment.charge.completed',
  PAYMENT_CHARGE_FAILED:       'payment.charge.failed',
  PAYMENT_REFUND_REQUESTED:    'payment.refund.requested',

  NOTIFICATION_PUSH_REQUESTED:  'notification.push.requested',
  NOTIFICATION_SMS_REQUESTED:   'notification.sms.requested',
  NOTIFICATION_EMAIL_REQUESTED: 'notification.email.requested',
} as const;

export type KafkaTopic = (typeof KAFKA_TOPICS)[keyof typeof KAFKA_TOPICS];

export const toDlqTopic = (topic: KafkaTopic): string => `${topic}.dlq`;
