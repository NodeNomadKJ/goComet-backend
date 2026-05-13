import type { KafkaTopic } from '../constants/kafka-topics.constants';
export interface DomainEvent<T = unknown> {
    eventId: string;
    eventType: KafkaTopic;
    tenantId: string;
    regionId: string;
    correlationId: string;
    timestamp: string;
    schemaVersion: number;
    payload: T;
}
//# sourceMappingURL=domain-event.interface.d.ts.map