import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { PaymentService } from '../payment.service';
import { PaymentEntity } from '../entities/payment.entity';
import { KafkaProducerService } from '../../kafka/kafka-producer.service';
import { PaymentStatus } from '@gocomet/common';

const mockPayment: Partial<PaymentEntity> = {
  id: 'pay-1',
  tripId: 'trip-1',
  riderId: 'rider-1',
  tenantId: 'tenant-1',
  regionId: 'region-1',
  amount: 150,
  currency: 'INR',
  status: PaymentStatus.PENDING,
  pspReference: undefined,
  failureReason: undefined,
  processedAt: undefined,
};

const mockRepo = {
  findOne: jest.fn(),
  save: jest.fn(),
};

const mockKafka = {
  emit: jest.fn().mockResolvedValue(undefined),
};

describe('PaymentService', () => {
  let service: PaymentService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        PaymentService,
        { provide: getRepositoryToken(PaymentEntity), useValue: mockRepo },
        { provide: KafkaProducerService, useValue: mockKafka },
      ],
    }).compile();

    service = module.get(PaymentService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('getPayment', () => {
    it('returns the payment when requester is the rider', async () => {
      mockRepo.findOne.mockResolvedValue(mockPayment);
      const result = await service.getPayment('pay-1', 'tenant-1', 'rider-1');
      expect(result).toEqual(mockPayment);
    });

    it('throws NotFoundException when payment not found', async () => {
      mockRepo.findOne.mockResolvedValue(null);
      await expect(service.getPayment('pay-x', 'tenant-1', 'rider-1')).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when requester is not the rider', async () => {
      mockRepo.findOne.mockResolvedValue(mockPayment);
      await expect(service.getPayment('pay-1', 'tenant-1', 'other-user')).rejects.toThrow(NotFoundException);
    });
  });

  describe('handleWebhook', () => {
    it('marks payment COMPLETED and emits PAYMENT_CHARGE_COMPLETED on success', async () => {
      const payment = { ...mockPayment };
      mockRepo.findOne.mockResolvedValue(payment);
      mockRepo.save.mockResolvedValue(payment);

      await service.handleWebhook('tenant-1', {
        pspReference: 'psp-abc',
        paymentId: 'pay-1',
        status: 'success',
      });

      expect(payment.status).toBe(PaymentStatus.COMPLETED);
      expect(payment.pspReference).toBe('psp-abc');
      expect(mockKafka.emit).toHaveBeenCalledWith(
        'payment.charge.completed',
        expect.objectContaining({ paymentId: 'pay-1', tripId: 'trip-1' }),
        'tenant-1',
        'region-1',
      );
    });

    it('marks payment FAILED and emits PAYMENT_CHARGE_FAILED on failure', async () => {
      const payment = { ...mockPayment };
      mockRepo.findOne.mockResolvedValue(payment);
      mockRepo.save.mockResolvedValue(payment);

      await service.handleWebhook('tenant-1', {
        pspReference: 'psp-xyz',
        paymentId: 'pay-1',
        status: 'failure',
        failureReason: 'Insufficient funds',
      });

      expect(payment.status).toBe(PaymentStatus.FAILED);
      expect(payment.failureReason).toBe('Insufficient funds');
      expect(mockKafka.emit).toHaveBeenCalledWith(
        'payment.charge.failed',
        expect.objectContaining({ failureReason: 'Insufficient funds' }),
        'tenant-1',
        'region-1',
      );
    });

    it('does nothing when payment not found', async () => {
      mockRepo.findOne.mockResolvedValue(null);
      await service.handleWebhook('tenant-1', { pspReference: 'psp-none', paymentId: 'pay-x', status: 'success' });
      expect(mockRepo.save).not.toHaveBeenCalled();
      expect(mockKafka.emit).not.toHaveBeenCalled();
    });
  });
});
