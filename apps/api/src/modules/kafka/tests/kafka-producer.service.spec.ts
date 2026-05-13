import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { KafkaProducerService } from '../kafka-producer.service';

const mockSend = jest.fn().mockResolvedValue(undefined);
const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockDisconnect = jest.fn().mockResolvedValue(undefined);

jest.mock('kafkajs', () => ({
  Kafka: jest.fn().mockImplementation(() => ({
    producer: jest.fn().mockReturnValue({
      connect: mockConnect,
      disconnect: mockDisconnect,
      send: mockSend,
    }),
  })),
  CompressionTypes: { GZIP: 1 },
}));

describe('KafkaProducerService', () => {
  let service: KafkaProducerService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        KafkaProducerService,
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue('localhost:19092') } },
      ],
    }).compile();

    service = module.get(KafkaProducerService);
    await service.onModuleInit();
  });

  afterEach(() => jest.clearAllMocks());

  it('connects the producer on init', () => {
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it('emit() calls producer.send with GZIP compression', async () => {
    await service.emit('ride.request.created', { rideId: 'r1' }, 'tenant1', 'region1');

    expect(mockSend).toHaveBeenCalledTimes(1);
    const call = mockSend.mock.calls[0][0] as { topic: string; compression: number; messages: Array<{ key: string; value: string }> };
    expect(call.topic).toBe('ride.request.created');
    expect(call.compression).toBe(1); // GZIP
    expect(call.messages).toHaveLength(1);
    expect(call.messages[0].key).toBe('tenant1');
  });

  it('emitted event envelope has required fields', async () => {
    await service.emit('trip.status.changed', { tripId: 't1' }, 'tenant1', 'region1', 'corr-123');

    const raw = mockSend.mock.calls[0][0].messages[0].value as string;
    const event = JSON.parse(raw);
    expect(event.eventType).toBe('trip.status.changed');
    expect(event.tenantId).toBe('tenant1');
    expect(event.regionId).toBe('region1');
    expect(event.correlationId).toBe('corr-123');
    expect(event.schemaVersion).toBe(1);
    expect(event.payload).toEqual({ tripId: 't1' });
  });

  it('disconnects the producer on destroy', async () => {
    await service.onModuleDestroy();
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
  });
});
