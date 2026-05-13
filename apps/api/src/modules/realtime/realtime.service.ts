import { Injectable } from '@nestjs/common';
import { RiderGateway } from './gateways/rider.gateway';
import { DriverGateway } from './gateways/driver.gateway';
import { WsEvents } from './events/realtime-event.types';
import type {
  DriverLocationPayload,
  RideStatusPayload,
  RideOfferPayload,
} from './events/realtime-event.types';

@Injectable()
export class RealtimeService {
  constructor(
    private readonly riderGateway: RiderGateway,
    private readonly driverGateway: DriverGateway,
  ) {}

  // Broadcast ride status change to everyone in the ride room
  emitRideStatus(rideId: string, payload: RideStatusPayload): void {
    this.riderGateway.server.to(`ride:${rideId}`).emit(WsEvents.RIDE_STATUS, payload);
  }

  // Push real-time driver location to the rider watching that ride
  emitDriverLocation(rideId: string, payload: DriverLocationPayload): void {
    this.riderGateway.server.to(`ride:${rideId}`).emit(WsEvents.DRIVER_LOCATION, payload);
  }

  // Send a ride offer to a specific driver
  emitRideOffer(driverId: string, payload: RideOfferPayload): void {
    this.driverGateway.server.to(`driver:${driverId}`).emit(WsEvents.RIDE_OFFER, payload);
  }

  // Generic emit to a rider's personal room (e.g., notifications)
  emitToRider(userId: string, event: string, payload: unknown): void {
    this.riderGateway.server.to(`user:${userId}`).emit(event, payload);
  }

  // Generic emit to a driver's dispatch room
  emitToDriver(driverId: string, event: string, payload: unknown): void {
    this.driverGateway.server.to(`driver:${driverId}`).emit(event, payload);
  }
}
