import { IsEnum, IsNumber, IsOptional, IsUUID, Max, Min, ValidateIf } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DriverStatus } from '@gocomet/common';

export class AvailabilityDto {
  @ApiProperty({ enum: [DriverStatus.AVAILABLE, DriverStatus.OFFLINE] })
  @IsEnum([DriverStatus.AVAILABLE, DriverStatus.OFFLINE], {
    message: 'status must be AVAILABLE or OFFLINE',
  })
  status: DriverStatus.AVAILABLE | DriverStatus.OFFLINE;

  @ApiPropertyOptional({ description: 'Required when going AVAILABLE', example: 28.6139 })
  @ValidateIf((o: AvailabilityDto) => o.status === DriverStatus.AVAILABLE)
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat?: number;

  @ApiPropertyOptional({ description: 'Required when going AVAILABLE', example: 77.209 })
  @ValidateIf((o: AvailabilityDto) => o.status === DriverStatus.AVAILABLE)
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng?: number;

  @ApiPropertyOptional({ description: 'Vehicle to use for this session' })
  @IsOptional()
  @IsUUID()
  vehicleId?: string;
}
