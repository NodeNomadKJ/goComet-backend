"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotificationStatus = exports.NotificationChannel = exports.NotificationType = void 0;
var NotificationType;
(function (NotificationType) {
    NotificationType["DRIVER_ASSIGNED"] = "DRIVER_ASSIGNED";
    NotificationType["DRIVER_ARRIVING"] = "DRIVER_ARRIVING";
    NotificationType["DRIVER_ARRIVED"] = "DRIVER_ARRIVED";
    NotificationType["RIDE_STARTED"] = "RIDE_STARTED";
    NotificationType["RIDE_COMPLETED"] = "RIDE_COMPLETED";
    NotificationType["RIDE_CANCELLED"] = "RIDE_CANCELLED";
    NotificationType["MATCHING_FAILED"] = "MATCHING_FAILED";
    NotificationType["PAYMENT_COMPLETED"] = "PAYMENT_COMPLETED";
    NotificationType["PAYMENT_FAILED"] = "PAYMENT_FAILED";
    NotificationType["OTP"] = "OTP";
    NotificationType["PASSWORD_RESET"] = "PASSWORD_RESET";
    NotificationType["NEW_RIDE_OFFER"] = "NEW_RIDE_OFFER";
})(NotificationType || (exports.NotificationType = NotificationType = {}));
var NotificationChannel;
(function (NotificationChannel) {
    NotificationChannel["PUSH"] = "PUSH";
    NotificationChannel["SMS"] = "SMS";
    NotificationChannel["EMAIL"] = "EMAIL";
})(NotificationChannel || (exports.NotificationChannel = NotificationChannel = {}));
var NotificationStatus;
(function (NotificationStatus) {
    NotificationStatus["PENDING"] = "PENDING";
    NotificationStatus["SENT"] = "SENT";
    NotificationStatus["FAILED"] = "FAILED";
})(NotificationStatus || (exports.NotificationStatus = NotificationStatus = {}));
//# sourceMappingURL=notification-type.enum.js.map