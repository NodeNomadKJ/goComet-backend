import { IsString, MaxLength, IsOptional } from 'class-validator';

export class CancelTripDto {
  @IsString()
  @MaxLength(500)
  @IsOptional()
  reason?: string;
}
