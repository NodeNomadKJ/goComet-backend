import { Test, TestingModule } from '@nestjs/testing';
import { RealtimeService } from '../realtime.service';
import { RiderGateway } from '../gateways/rider.gateway';
import { DriverGateway } from '../gateways/driver.gateway';
import { WsEvents } from '../events/realtime-event.types';
import { RideStatus, VehicleType } from '@gocomet/common';

const makeNamespace = () => ({
  to: jest.fn().mockReturnThis(),
  emit: jest.fn(),
});

const mockRiderGateway = { server: makeNamespace() };
const mockDriverGateway = { server: makeNamespace() };

describe('RealtimeService', () => {
  let service: RealtimeService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockRiderGateway.server = makeNamespace();
    mockDriverGateway.server = makeNamespace();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RealtimeService,
        { provide: RiderGateway, useValue: mockRiderGateway },
        { provide: DriverGateway, useValue: mockDriverGateway },
      ],
    }).compile();

    service = module.get<RealtimeService>(RealtimeService);
  });

  describe('emitRideStatus', () => {
    it('targets the ride room on the rider namespace', () => {
      const payload = { rideId: 'ride-1', status: RideStatus.MATCHING };

      service.emitRideStatus('ride-1', payload);

      expect(mockRiderGateway.server.to).toHaveBeenCalledWith('ride:ride-1');
      expect(mockRiderGateway.server.emit).toHaveBeenCalledWith(WsEvents.RIDE_STATUS, payload);
    });
  });

  describe('emitDriverLocation', () => {
    it('sends driver:location to the ride room on the rider namespace', () => {
      const payload = { driverId: 'drv-1', lat: 12.97, lng: 77.59, timestamp: Date.now() };

      service.emitDriverLocation('ride-1', payload);

      expect(mockRiderGateway.server.to).toHaveBeenCalledWith('ride:ride-1');
      expect(mockRiderGateway.server.emit).toHaveBeenCalledWith(WsEvents.DRIVER_LOCATION, payload);
    });
  });

  describe('emitRideOffer', () => {
    it('sends ride:offer to the driver dispatch room', () => {
      const payload = {
        rideId: 'ride-1',
        riderId: 'rider-1',
        pickupLat: 12.97,
        pickupLng: 77.59,
        pickupAddress: 'MG Road',
        dropAddress: 'Koramangala',
        fareEstimate: 150,
        vehicleType: VehicleType.ECONOMY,
        expiresAt: Date.now() + 6000,
      };

      service.emitRideOffer('drv-1', payload);

      expect(mockDriverGateway.server.to).toHaveBeenCalledWith('driver:drv-1');
      expect(mockDriverGateway.server.emit).toHaveBeenCalledWith(WsEvents.RIDE_OFFER, payload);
    });
  });

  describe('emitToRider', () => {
    it('sends arbitrary events to the rider personal room', () => {
      service.emitToRider('user-1', 'promo:alert', { message: 'Free ride!' });

      expect(mockRiderGateway.server.to).toHaveBeenCalledWith('user:user-1');
      expect(mockRiderGateway.server.emit).toHaveBeenCalledWith('promo:alert', { message: 'Free ride!' });
    });
  });

  describe('emitToDriver', () => {
    it('sends arbitrary events to the driver dispatch room', () => {
      service.emitToDriver('drv-1', 'trip:update', { eta: 180 });

      expect(mockDriverGateway.server.to).toHaveBeenCalledWith('driver:drv-1');
      expect(mockDriverGateway.server.emit).toHaveBeenCalledWith('trip:update', { eta: 180 });
    });
  });
});
