import { IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength, Matches } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { VehicleType } from '@gocomet/common';

export class UpdateRiderDto {
  @ApiPropertyOptional({ example: 'Alice Rider' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ example: '+919876543210', description: 'E.164 format' })
  @IsOptional()
  @Matches(/^\+[1-9]\d{1,14}$/, { message: 'phone must be in E.164 format' })
  phone?: string;

  @ApiPropertyOptional({ enum: VehicleType })
  @IsOptional()
  @IsEnum(VehicleType)
  defaultVehicleType?: VehicleType;

  @ApiPropertyOptional({ description: 'ID of preferred payment method' })
  @IsOptional()
  @IsUUID()
  defaultPaymentMethodId?: string | null;
}
