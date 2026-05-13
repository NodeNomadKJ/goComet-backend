import { IsString, IsNotEmpty, IsOptional, IsObject, Length } from 'class-validator';

export class CreateRegionDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @Length(2, 3)
  countryCode: string;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}
