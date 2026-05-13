export declare const KAFKA_TOPICS: {
    readonly RIDE_REQUEST_CREATED: "ride.request.created";
    readonly RIDE_MATCHING_STARTED: "ride.matching.started";
    readonly RIDE_MATCHING_FAILED: "ride.matching.failed";
    readonly RIDE_REQUEST_CANCELLED: "ride.request.cancelled";
    readonly DRIVER_AVAILABILITY_CHANGED: "driver.availability.changed";
    readonly DRIVER_ASSIGNMENT_CREATED: "driver.assignment.created";
    readonly DRIVER_LOCATION_UPDATED: "driver.location.updated";
    readonly TRIP_STATUS_CHANGED: "trip.status.changed";
    readonly TRIP_COMPLETED: "trip.completed";
    readonly PAYMENT_CHARGE_REQUESTED: "payment.charge.requested";
    readonly PAYMENT_CHARGE_COMPLETED: "payment.charge.completed";
    readonly PAYMENT_CHARGE_FAILED: "payment.charge.failed";
    readonly PAYMENT_REFUND_REQUESTED: "payment.refund.requested";
    readonly NOTIFICATION_PUSH_REQUESTED: "notification.push.requested";
    readonly NOTIFICATION_SMS_REQUESTED: "notification.sms.requested";
    readonly NOTIFICATION_EMAIL_REQUESTED: "notification.email.requested";
};
export type KafkaTopic = (typeof KAFKA_TOPICS)[keyof typeof KAFKA_TOPICS];
export declare const toDlqTopic: (topic: KafkaTopic) => string;
//# sourceMappingURL=kafka-topics.constants.d.ts.map