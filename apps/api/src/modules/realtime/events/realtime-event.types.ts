import { RideStatus, VehicleType } from '@gocomet/common';

export const WsEvents = {
  // Client → Server
  JOIN_RIDE_ROOM: 'join:ride',
  OFFER_RESPONSE: 'offer:response',
  LOCATION_UPDATE: 'location:update',
  // Server → Client
  RIDE_STATUS: 'ride:status',
  DRIVER_LOCATION: 'driver:location',
  RIDE_OFFER: 'ride:offer',
  ERROR: 'error',
} as const;

export type WsEventName = (typeof WsEvents)[keyof typeof WsEvents];

export interface DriverLocationPayload {
  driverId: string;
  lat: number;
  lng: number;
  heading?: number;
  timestamp: number;
}

export interface RideStatusPayload {
  rideId: string;
  status: RideStatus;
  driverId?: string;
  driverName?: string;
  driverLat?: number;
  driverLng?: number;
  estimatedArrivalSec?: number;
}

export interface RideOfferPayload {
  rideId: string;
  riderId: string;
  pickupLat: number;
  pickupLng: number;
  pickupAddress: string;
  dropAddress: string;
  fareEstimate: number;
  vehicleType: VehicleType;
  expiresAt: number;
}

export interface OfferResponsePayload {
  rideId: string;
  accepted: boolean;
}

export interface LocationUpdatePayload {
  lat: number;
  lng: number;
  heading?: number;
}
