import { IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CancelRideDto {
  @ApiProperty({ example: 'Changed my mind' })
  @IsString()
  @MinLength(3)
  @MaxLength(255)
  reason: string;
}
