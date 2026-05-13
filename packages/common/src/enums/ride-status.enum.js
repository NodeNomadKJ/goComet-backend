"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RideStatus = void 0;
var RideStatus;
(function (RideStatus) {
    RideStatus["REQUESTED"] = "REQUESTED";
    RideStatus["MATCHING"] = "MATCHING";
    RideStatus["DRIVER_ASSIGNED"] = "DRIVER_ASSIGNED";
    RideStatus["DRIVER_ARRIVING"] = "DRIVER_ARRIVING";
    RideStatus["DRIVER_ARRIVED"] = "DRIVER_ARRIVED";
    RideStatus["RIDE_STARTED"] = "RIDE_STARTED";
    RideStatus["COMPLETED"] = "COMPLETED";
    RideStatus["PAYMENT_PENDING"] = "PAYMENT_PENDING";
    RideStatus["PAYMENT_COMPLETED"] = "PAYMENT_COMPLETED";
    RideStatus["CANCELLED"] = "CANCELLED";
    RideStatus["FAILED"] = "FAILED";
})(RideStatus || (exports.RideStatus = RideStatus = {}));
//# sourceMappingURL=ride-status.enum.js.map