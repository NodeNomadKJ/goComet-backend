import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { RiderService } from '../rider.service';
import { RiderEntity } from '../entities/rider.entity';
import { RiderPaymentMethodEntity, PaymentMethodType } from '../entities/rider-payment-method.entity';
import { UserService } from '../../users/user.service';
import { RideService } from '../../rides/ride.service';
import { VehicleType } from '@gocomet/common';

const mockRiderRepo = {
  findOne: jest.fn(),
  create: jest.fn(),
  save: jest.fn(),
  count: jest.fn(),
  update: jest.fn(),
};

const mockPaymentRepo = {
  find: jest.fn(),
  create: jest.fn(),
  save: jest.fn(),
  count: jest.fn(),
  update: jest.fn(),
};

const mockUserService = {
  findById: jest.fn(),
};

const mockRideService = {
  getRidesByRider: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 }),
};

const baseRider: RiderEntity = {
  id: 'rider-1',
  userId: 'user-1',
  tenantId: 'tenant-1',
  regionId: 'region-1',
  name: 'Alice Rider',
  email: 'alice@example.com',
  phone: '+919876543210',
  rating: 5,
  totalRides: 0,
  preferences: { defaultVehicleType: VehicleType.ECONOMY, defaultPaymentMethodId: null },
  createdAt: new Date(),
  updatedAt: new Date(),
  isDeleted: false,
} as RiderEntity;

describe('RiderService', () => {
  let service: RiderService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RiderService,
        { provide: getRepositoryToken(RiderEntity), useValue: mockRiderRepo },
        { provide: getRepositoryToken(RiderPaymentMethodEntity), useValue: mockPaymentRepo },
        { provide: UserService, useValue: mockUserService },
        { provide: RideService, useValue: mockRideService },
      ],
    }).compile();

    service = module.get<RiderService>(RiderService);
  });

  describe('findOrCreateProfile', () => {
    it('returns existing profile without hitting UserService', async () => {
      mockRiderRepo.findOne.mockResolvedValue(baseRider);

      const result = await service.findOrCreateProfile('user-1', 'tenant-1', 'region-1');

      expect(result).toBe(baseRider);
      expect(mockUserService.findById).not.toHaveBeenCalled();
    });

    it('creates profile on first access using data from UserService', async () => {
      mockRiderRepo.findOne.mockResolvedValue(null);
      mockUserService.findById.mockResolvedValue({
        id: 'user-1', name: 'Alice Rider', email: 'alice@example.com', phone: '+919876543210',
      });
      mockRiderRepo.create.mockReturnValue(baseRider);
      mockRiderRepo.save.mockResolvedValue(baseRider);

      const result = await service.findOrCreateProfile('user-1', 'tenant-1', 'region-1');

      expect(mockUserService.findById).toHaveBeenCalledWith('user-1', 'tenant-1');
      expect(mockRiderRepo.save).toHaveBeenCalled();
      expect(result.name).toBe('Alice Rider');
    });

    it('throws NotFoundException when user does not exist', async () => {
      mockRiderRepo.findOne.mockResolvedValue(null);
      mockUserService.findById.mockResolvedValue(null);

      await expect(service.findOrCreateProfile('ghost', 'tenant-1', 'region-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateProfile', () => {
    it('updates name and phone', async () => {
      mockRiderRepo.findOne.mockResolvedValue({ ...baseRider });
      const updated = { ...baseRider, name: 'Alice Updated', phone: '+911234567890' };
      mockRiderRepo.save.mockResolvedValue(updated);

      const result = await service.updateProfile('user-1', 'tenant-1', {
        name: 'Alice Updated',
        phone: '+911234567890',
      });

      expect(result.name).toBe('Alice Updated');
    });

    it('merges preferences without overwriting unset fields', async () => {
      const rider = { ...baseRider, preferences: { defaultVehicleType: VehicleType.ECONOMY, defaultPaymentMethodId: 'pm-1' } };
      mockRiderRepo.findOne.mockResolvedValue(rider);
      mockRiderRepo.save.mockImplementation((r: RiderEntity) => Promise.resolve(r));

      const result = await service.updateProfile('user-1', 'tenant-1', {
        defaultVehicleType: VehicleType.PREMIUM,
      });

      expect(result.preferences.defaultVehicleType).toBe(VehicleType.PREMIUM);
      expect(result.preferences.defaultPaymentMethodId).toBe('pm-1');
    });

    it('throws NotFoundException when profile does not exist', async () => {
      mockRiderRepo.findOne.mockResolvedValue(null);

      await expect(service.updateProfile('user-1', 'tenant-1', { name: 'X' })).rejects.toThrow(NotFoundException);
    });
  });

  describe('getRideHistory', () => {
    it('returns empty paginated result (ride module not yet implemented)', async () => {
      const result = await service.getRideHistory('rider-1', 'tenant-1', 2, 10);

      expect(result.data).toHaveLength(0);
      expect(result.total).toBe(0);
      expect(result.page).toBe(2);
      expect(result.limit).toBe(10);
    });
  });

  describe('addPaymentMethod', () => {
    it('marks first payment method as default', async () => {
      mockPaymentRepo.count.mockResolvedValue(0);
      const method = { id: 'pm-1', riderId: 'rider-1', type: PaymentMethodType.CARD, isDefault: true };
      mockPaymentRepo.create.mockReturnValue(method);
      mockPaymentRepo.save.mockResolvedValue(method);

      const result = await service.addPaymentMethod('rider-1', 'tenant-1', 'region-1', {
        type: PaymentMethodType.CARD,
        provider: 'Visa',
        maskedDetails: '**** 4242',
      });

      expect(result.isDefault).toBe(true);
    });

    it('does not set default when other methods exist', async () => {
      mockPaymentRepo.count.mockResolvedValue(1);
      const method = { id: 'pm-2', riderId: 'rider-1', type: PaymentMethodType.UPI, isDefault: false };
      mockPaymentRepo.create.mockReturnValue(method);
      mockPaymentRepo.save.mockResolvedValue(method);

      const result = await service.addPaymentMethod('rider-1', 'tenant-1', 'region-1', {
        type: PaymentMethodType.UPI,
      });

      expect(result.isDefault).toBe(false);
    });
  });

  describe('setDefaultPaymentMethod', () => {
    it('clears all defaults then sets the target', async () => {
      mockPaymentRepo.update.mockResolvedValueOnce({ affected: 1 }).mockResolvedValueOnce({ affected: 1 });

      await service.setDefaultPaymentMethod('rider-1', 'tenant-1', 'pm-1');

      expect(mockPaymentRepo.update).toHaveBeenCalledTimes(2);
      expect(mockPaymentRepo.update).toHaveBeenNthCalledWith(
        1, { riderId: 'rider-1', tenantId: 'tenant-1' }, { isDefault: false },
      );
    });

    it('throws NotFoundException when method id does not belong to rider', async () => {
      mockPaymentRepo.update
        .mockResolvedValueOnce({ affected: 1 })
        .mockResolvedValueOnce({ affected: 0 });

      await expect(
        service.setDefaultPaymentMethod('rider-1', 'tenant-1', 'wrong-id'),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
