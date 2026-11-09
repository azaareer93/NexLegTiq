import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiNoContentResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CreateTimeEntrySchema,
  StartTimerSchema,
  StopTimerSchema,
  TimeEntryQuerySchema,
  TimeEntrySchema,
  TimerSchema,
  TimeTotalsSchema,
  UpdateTimeEntrySchema,
} from '@nexlegtiq/shared-contracts';
import type {
  CreateTimeEntryRequest,
  StartTimerRequest,
  StopTimerRequest,
  TimeEntry,
  TimeEntryQuery,
  Timer,
  TimeTotals,
  UpdateTimeEntryRequest,
} from '@nexlegtiq/shared-contracts';

import { TimeEntriesService } from './time-entries.service';
import { TimerService } from './time-timer.service';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import type { PaginatedResult } from '../../common/http/paginated-result';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe';
import { ApiZodBody, ApiZodQuery, ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { RequireAnyPermission, RequirePermissions } from '../../common/rbac/permissions.decorator';

const entryId = new ParseUUIDPipe({ exceptionFactory: () => new ResourceNotFoundException() });

/** Time entries and the running timer (api-conventions.md#billing, MVP-90, D-152). All need `log:time`. */
@ApiTags('time-entries')
@ApiBearerAuth('JWT')
@Controller('time-entries')
@RequirePermissions('log:time')
export class TimeEntriesController {
  constructor(
    private readonly time: TimeEntriesService,
    private readonly timers: TimerService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Time entries the caller may see (their own unless OM/SL)' })
  @ApiZodQuery(TimeEntryQuerySchema)
  @ApiZodResponse(HttpStatus.OK, TimeEntrySchema, { paginated: true })
  list(
    @Query(new ZodValidationPipe(TimeEntryQuerySchema)) query: TimeEntryQuery,
  ): Promise<PaginatedResult<TimeEntry>> {
    return this.time.list(query);
  }

  @Post()
  @ApiOperation({
    summary: 'Log time on a file (rate and currency from the file, else the office)',
  })
  @ApiZodBody(CreateTimeEntrySchema)
  @ApiZodResponse(HttpStatus.CREATED, TimeEntrySchema)
  create(
    @Body(new ZodValidationPipe(CreateTimeEntrySchema)) body: CreateTimeEntryRequest,
  ): Promise<TimeEntry> {
    return this.time.create(body);
  }

  // Before `:id` routes: Nest matches in declaration order.
  @Get('timer')
  @ApiOperation({ summary: "The caller's running timer, or null" })
  @ApiZodResponse(HttpStatus.OK, TimerSchema.nullable())
  timer(): Promise<Timer | null> {
    return this.timers.timer();
  }

  @Post('timer/start')
  @ApiOperation({ summary: 'Start a timer on a file (one per user; 409 RES-002 while one runs)' })
  @ApiZodBody(StartTimerSchema)
  @ApiZodResponse(HttpStatus.CREATED, TimerSchema)
  start(@Body(new ZodValidationPipe(StartTimerSchema)) body: StartTimerRequest): Promise<Timer> {
    return this.timers.start(body);
  }

  @Post('timer/stop')
  @ApiOperation({
    summary: "Stop the caller's timer and log its time, rounded up to the office increment",
  })
  @ApiZodBody(StopTimerSchema)
  @ApiZodResponse(HttpStatus.CREATED, TimeEntrySchema)
  stop(@Body(new ZodValidationPipe(StopTimerSchema)) body: StopTimerRequest): Promise<TimeEntry> {
    return this.timers.stop(body);
  }

  @Get(':id')
  @ApiZodResponse(HttpStatus.OK, TimeEntrySchema)
  get(@Param('id', entryId) id: string): Promise<TimeEntry> {
    return this.time.get(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Change an entry (own, or any as OM/SL); invoiced entries are 422 BIZ-006',
  })
  @ApiZodBody(UpdateTimeEntrySchema)
  @ApiZodResponse(HttpStatus.OK, TimeEntrySchema)
  update(
    @Param('id', entryId) id: string,
    @Body(new ZodValidationPipe(UpdateTimeEntrySchema)) body: UpdateTimeEntryRequest,
  ): Promise<TimeEntry> {
    return this.time.update(id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  remove(@Param('id', entryId) id: string): Promise<void> {
    return this.time.remove(id);
  }
}

/** `GET /cases/:id/time-totals` (D-152): for anyone who reads the file; amounts with invoice rights only. */
@ApiTags('time-entries')
@ApiBearerAuth('JWT')
@Controller('cases/:id/time-totals')
export class CaseTimeTotalsController {
  constructor(private readonly time: TimeEntriesService) {}

  @Get()
  @RequireAnyPermission('view:all:cases', 'view:assigned:cases')
  @ApiZodResponse(HttpStatus.OK, TimeTotalsSchema)
  totals(@Param('id', entryId) id: string): Promise<TimeTotals> {
    return this.time.totals(id);
  }
}
