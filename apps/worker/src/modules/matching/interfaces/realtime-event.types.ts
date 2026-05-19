import type { VehicleType } from '@gocomet/common';

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
