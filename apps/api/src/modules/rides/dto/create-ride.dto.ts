import { IsEnum, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VehicleType } from '@gocomet/common';

export class CreateRideDto {
  @ApiProperty({ example: 28.6139 })
  @IsNumber()
  @Min(-90)
  @Max(90)
  pickupLat: number;

  @ApiProperty({ example: 77.209 })
  @IsNumber()
  @Min(-180)
  @Max(180)
  pickupLng: number;

  @ApiProperty({ example: 'Connaught Place, New Delhi' })
  @IsString()
  @MinLength(3)
  @MaxLength(255)
  pickupAddress: string;

  @ApiProperty({ example: 28.5355 })
  @IsNumber()
  @Min(-90)
  @Max(90)
  dropLat: number;

  @ApiProperty({ example: 77.391 })
  @IsNumber()
  @Min(-180)
  @Max(180)
  dropLng: number;

  @ApiProperty({ example: 'Noida Sector 18' })
  @IsString()
  @MinLength(3)
  @MaxLength(255)
  dropAddress: string;

  @ApiPropertyOptional({ enum: VehicleType, default: VehicleType.ECONOMY })
  @IsOptional()
  @IsEnum(VehicleType)
  vehicleType?: VehicleType;

  @ApiPropertyOptional({ description: 'Preferred payment method ID' })
  @IsOptional()
  @IsUUID()
  paymentMethodId?: string;
}
