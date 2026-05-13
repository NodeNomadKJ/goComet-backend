import { IsString, IsIn, IsOptional } from 'class-validator';

export class WebhookDto {
  @IsString()
  paymentId: string;

  @IsString()
  pspReference: string;

  @IsString()
  @IsIn(['success', 'failure'])
  status: 'success' | 'failure';

  @IsString()
  @IsOptional()
  failureReason?: string;
}
