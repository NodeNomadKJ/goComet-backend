import { IsEnum, IsNumber, IsOptional, Max, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VehicleType } from '@gocomet/common';

export class FareEstimateDto {
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

  @ApiPropertyOptional({ enum: VehicleType, default: VehicleType.ECONOMY })
  @IsOptional()
  @IsEnum(VehicleType)
  vehicleType?: VehicleType;
}
