import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethodType } from '../entities/rider-payment-method.entity';

export class AddPaymentMethodDto {
  @ApiProperty({ enum: PaymentMethodType, example: PaymentMethodType.CARD })
  @IsEnum(PaymentMethodType)
  type: PaymentMethodType;

  @ApiPropertyOptional({ example: 'Visa' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  provider?: string;

  @ApiPropertyOptional({ example: '**** 4242' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  maskedDetails?: string;
}
