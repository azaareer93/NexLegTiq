import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { SearchQuerySchema, SearchResultsSchema } from '@nexlegtiq/shared-contracts';
import type { SearchQuery, SearchResults } from '@nexlegtiq/shared-contracts';

import { SearchService } from './search.service';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe';
import { ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { RequireAnyPermission } from '../../common/rbac/permissions.decorator';

/** Global search (MVP-81, D-167): what the caller may open, grouped by type. */
@ApiTags('search')
@ApiBearerAuth('JWT')
@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  @RequireAnyPermission('view:all:cases', 'view:assigned:cases')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Search cases, clients, parties, documents and tasks the caller may open (q ≥ 2 characters; limit per group)',
  })
  @ApiZodResponse(200, SearchResultsSchema)
  search(
    @Query(new ZodValidationPipe(SearchQuerySchema)) query: SearchQuery,
  ): Promise<SearchResults> {
    return this.searchService.search(query);
  }
}
