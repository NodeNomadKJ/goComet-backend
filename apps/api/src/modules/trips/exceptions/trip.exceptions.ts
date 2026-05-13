import { NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import type { TripStatus } from '@gocomet/common';

export class TripNotFoundException extends NotFoundException {
  constructor(tripId: string) {
    super(`Trip ${tripId} not found`);
  }
}

export class InvalidTripTransitionException extends BadRequestException {
  constructor(from: TripStatus, to: TripStatus) {
    super(`Cannot transition trip from ${from} to ${to}`);
  }
}

export class TripAccessDeniedException extends ForbiddenException {
  constructor() {
    super('Access denied — not your trip');
  }
}
