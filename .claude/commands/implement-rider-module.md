# /implement-rider-module

Implement the Rider domain module. Prerequisite: auth module complete.

## What to Build

### File Structure

```
apps/api/src/modules/rider/
  rider.module.ts
  rider.controller.ts
  rider.service.ts
  dto/
    update-rider.dto.ts
    add-payment-method.dto.ts
    rider-response.dto.ts
    ride-history-query.dto.ts
  entities/
    rider.entity.ts
    rider-payment-method.entity.ts
  interfaces/
    rider.interface.ts
  exceptions/
    rider.exceptions.ts
  tests/
    rider.service.spec.ts
```

### RiderEntity

```typescript
@Entity('riders')
@Index(['tenantId', 'regionId'])
@Index(['userId'], { unique: true })
export class RiderEntity extends BaseEntity {
  @Column({ type: 'uuid' })
  userId: string;

  @OneToOne(() => UserEntity, { eager: false })
  @JoinColumn({ name: 'userId' })
  user: UserEntity;

  @Column({ nullable: true })
  displayName: string;

  @Column({ type: 'decimal', precision: 3, scale: 2, default: 5.0 })
  rating: number;

  @Column({ default: 0 })
  totalRides: number;

  @Column({ default: 0 })
  cancelledRides: number;

  @Column({ type: 'jsonb', nullable: true })
  preferences: {
    vehicleType?: string;
    preferredPaymentMethodId?: string;
    notifications?: {
      push: boolean;
      sms: boolean;
      email: boolean;
    };
  };

  @Column({ nullable: true })
  profileImageUrl: string;

  @OneToMany(() => RiderPaymentMethodEntity, (pm) => pm.rider)
  paymentMethods: RiderPaymentMethodEntity[];
}
```

### RiderPaymentMethodEntity

```typescript
@Entity('rider_payment_methods')
@Index(['tenantId', 'regionId', 'riderId'])
export class RiderPaymentMethodEntity extends BaseEntity {
  @Column({ type: 'uuid' })
  riderId: string;

  @ManyToOne(() => RiderEntity, (r) => r.paymentMethods)
  @JoinColumn({ name: 'riderId' })
  rider: RiderEntity;

  @Column({ type: 'enum', enum: PaymentMethodType })
  type: PaymentMethodType;  // CARD | UPI | WALLET | CASH

  @Column({ nullable: true })
  last4: string;  // last 4 digits for card

  @Column({ nullable: true })
  expiryMonth: number;

  @Column({ nullable: true })
  expiryYear: number;

  @Column({ nullable: true })
  pspTokenReference: string;  // PSP-side token (NOT full card number)

  @Column({ default: false })
  isDefault: boolean;
}
```

### Rider Service Methods

**getProfile(userId, tenantId)**
- Find rider by userId + tenantId
- Return rider with user (email, phone) joined
- Throw RiderNotFoundException if not found

**updateProfile(userId, tenantId, dto)**
- Validate allowed update fields (displayName, preferences, profileImageUrl)
- No direct email/phone update (goes through auth/verification flow)
- Return updated rider

**getRideHistory(userId, tenantId, query)**
- Query rides where riderId = rider.id AND tenantId = tenantId
- Paginated: default page=1, limit=20, max limit=100
- Filterable by: status, dateFrom, dateTo
- Order by createdAt DESC
- Return: { data: rides[], total, page, limit }

**addPaymentMethod(userId, tenantId, dto)**
- Tokenize with PSP (mock in Phase 1 — just store the input)
- Set isDefault=true if first payment method
- Enforce max 5 payment methods per rider

**removePaymentMethod(userId, riderId, paymentMethodId, tenantId)**
- Check ownership: payment method must belong to this rider
- Cannot remove default method if other methods exist (must set another as default first)
- Soft delete (isDeleted = true)

### Controller Endpoints

```
GET    /riders/me                      → getProfile (RIDER)
PATCH  /riders/me                      → updateProfile (RIDER)
GET    /riders/me/rides                → getRideHistory (RIDER)
GET    /riders/me/payment-methods      → listPaymentMethods (RIDER)
POST   /riders/me/payment-methods      → addPaymentMethod (RIDER)
DELETE /riders/me/payment-methods/:id  → removePaymentMethod (RIDER)
PATCH  /riders/me/payment-methods/:id/default → setDefaultPaymentMethod (RIDER)

Admin only:
GET    /admin/riders/:id               → getRiderById (ADMIN)
GET    /admin/riders                   → listRiders paginated (ADMIN)
PATCH  /admin/riders/:id/suspend       → suspendRider (ADMIN)
```

### Response Shape

Always wrap in:
```json
{
  "data": { ...riderProfile },
  "meta": { "timestamp": "..." }
}
```

Paginated:
```json
{
  "data": [...],
  "meta": { "total": 100, "page": 1, "limit": 20, "totalPages": 5 }
}
```

### UpdateRiderDto

```typescript
export class UpdateRiderDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(100)
  displayName?: string;

  @IsOptional() @IsUrl()
  profileImageUrl?: string;

  @IsOptional() @ValidateNested() @Type(() => RiderPreferencesDto)
  preferences?: RiderPreferencesDto;
}
```

### Exceptions

```typescript
export class RiderNotFoundException extends NotFoundException {
  constructor(id: string) { super(`Rider ${id} not found`); }
}
export class PaymentMethodNotFoundException extends NotFoundException {
  constructor(id: string) { super(`Payment method ${id} not found`); }
}
export class MaxPaymentMethodsException extends BadRequestException {
  constructor() { super('Maximum of 5 payment methods allowed'); }
}
```

### Unit Tests

```typescript
describe('RiderService', () => {
  it('returns rider profile with user data')
  it('throws when rider not found')
  it('updates displayName and preferences')
  it('returns paginated ride history')
  it('adds payment method and sets default if first')
  it('blocks adding 6th payment method')
  it('blocks removing default method when others exist')
})
```

## Update Progress

Check off all Rider Module items in PROJECT_PROGRESS.md.
