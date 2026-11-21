# Top 10 queries — plans (MVP-117, D-235)

From `pg_stat_statements` after the tuned 50-VU run ([baseline](baseline.md)), ordered by total time. Plans captured by
`auto_explain` (`log_analyze`, `log_buffers`, executions over 15 ms) during a light 5-VU run on the perf seed; ids in
them are perf-seed rows. Each plan is cut at 30 lines.

## 1. Search: document text (assigned-scope reader)

1014 calls · mean 186.3 ms · max 1866.0 ms · total 188.9 s

Slowest logged plan:

```
Limit  (cost=34571.24..34571.54 rows=6 width=40) (actual time=222.294..222.301 rows=6 loops=1)
Buffers: shared hit=71665 read=5491 written=1
->  Incremental Sort  (cost=34571.24..34571.54 rows=6 width=40) (actual time=222.294..222.300 rows=6 loops=1)
 Sort Key: hits.rank DESC, ((hits.id)::text)
 Presorted Key: hits.rank
 Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 25kB  Peak Memory: 25kB
 Buffers: shared hit=71665 read=5491 written=1
 ->  Subquery Scan on hits  (cost=34571.23..34571.27 rows=6 width=40) (actual time=222.285..222.293 rows=6 loops=1)
       Buffers: shared hit=71665 read=5491 written=1
       ->  Limit  (cost=34571.23..34571.24 rows=6 width=24) (actual time=222.283..222.289 rows=6 loops=1)
             Buffers: shared hit=71665 read=5491 written=1
             ->  Sort  (cost=34571.23..34571.93 rows=282 width=24) (actual time=222.283..222.288 rows=6 loops=1)
                   Sort Key: ((('1'::double precision + ts_rank(c.search_vector_simple, websearch_to_tsquery('simple'::regconfig, lower(translate(regexp_replace(unaccent('احمد النور'::text), '[ً-ٰٟـ]'::text, ''::text, 'g'::text), 'أإآٱىئؤة'::text, 'ااااييوه'::text))))) + ts_rank(c.search_vector_english, websearch_to_tsquery('english'::regconfig, unaccent('احمد النور'::text))))) DESC, c.id
                   Sort Method: top-N heapsort  Memory: 25kB
                   Buffers: shared hit=71665 read=5491 written=1
                   ->  Subquery Scan on c  (cost=34418.12..34566.17 rows=282 width=24) (actual time=210.645..222.170 rows=1000 loops=1)
                         Buffers: shared hit=71665 read=5491 written=1
                         ->  Limit  (cost=34418.12..34418.83 rows=282 width=955) (actual time=210.627..210.825 rows=1000 loops=1)
                               Buffers: shared hit=67665 read=5491 written=1
                               ->  Sort  (cost=34418.12..34418.83 rows=282 width=955) (actual time=210.627..210.765 rows=1000 loops=1)
                                     Sort Key: t.id DESC
                                     Sort Method: top-N heapsort  Memory: 2175kB
                                     Buffers: shared hit=67665 read=5491 written=1
                                     ->  Hash Semi Join  (cost=19769.86..34406.65 rows=282 width=955) (actual time=14.032..207.528 rows=2972 loops=1)
                                           Hash Cond: ((t.document_id = d.id) AND (t.version_number = d.current_version))
                                           Buffers: shared hit=67665 read=5491 written=1
                                           ->  Index Scan using document_texts_office_id_idx on document_texts t  (cost=0.42..14571.58 rows=11843 width=991) (actual time=0.079..189.644 rows=11899 loops=1)
                                                 Index Cond: (office_id = '01a1fe5c-0e50-75ea-bbd8-47f6893e7cdf'::uuid)
                                                 Filter: ((search_vector_simple @@ websearch_to_tsquery('simple'::regconfig, lower(translate(regexp_replace(unaccent('احمد النور'::text), '[ً-ٰٟـ]'::text, ''::text, 'g'::text), 'أإآٱىئؤة'::text, 'ااااييوه'::text)))) OR (search_vector_english @@ websearch_to_tsquery('english'::regconfig, unaccent('احمد النور'::text))))
                                                 Rows Removed by Filter: 8101
```

## 2. Search: document text (office-wide reader)

1007 calls · mean 182.2 ms · max 1623.6 ms · total 183.5 s

Slowest logged plan:

```
Limit  (cost=33112.72..33113.02 rows=6 width=40) (actual time=201.470..201.745 rows=6 loops=1)
Buffers: shared hit=77031 read=5206 written=25
->  Incremental Sort  (cost=33112.72..33113.02 rows=6 width=40) (actual time=201.470..201.744 rows=6 loops=1)
 Sort Key: hits.rank DESC, ((hits.id)::text)
 Presorted Key: hits.rank
 Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 25kB  Peak Memory: 25kB
 Buffers: shared hit=77031 read=5206 written=25
 ->  Subquery Scan on hits  (cost=33112.70..33112.75 rows=6 width=40) (actual time=201.451..201.726 rows=6 loops=1)
       Buffers: shared hit=77028 read=5206 written=25
       ->  Limit  (cost=33112.70..33112.72 rows=6 width=24) (actual time=201.449..201.723 rows=6 loops=1)
             Buffers: shared hit=77028 read=5206 written=25
             ->  Sort  (cost=33112.70..33114.53 rows=733 width=24) (actual time=201.449..201.722 rows=6 loops=1)
                   Sort Key: ((('1'::double precision + ts_rank(c.search_vector_simple, websearch_to_tsquery('simple'::regconfig, lower(translate(regexp_replace(unaccent('ايجار'::text), '[ً-ٰٟـ]'::text, ''::text, 'g'::text), 'أإآٱىئؤة'::text, 'ااااييوه'::text))))) + ts_rank(c.search_vector_english, websearch_to_tsquery('english'::regconfig, unaccent('ايجار'::text))))) DESC, c.id
                   Sort Method: top-N heapsort  Memory: 25kB
                   Buffers: shared hit=77028 read=5206 written=25
                   ->  Subquery Scan on c  (cost=32714.74..33099.56 rows=733 width=24) (actual time=190.353..201.434 rows=1000 loops=1)
                         Buffers: shared hit=77028 read=5206 written=25
                         ->  Limit  (cost=32714.74..32716.57 rows=733 width=955) (actual time=190.329..190.826 rows=1000 loops=1)
                               Buffers: shared hit=73028 read=5206 written=25
                               ->  Sort  (cost=32714.74..32716.57 rows=733 width=955) (actual time=190.329..190.755 rows=1000 loops=1)
                                     Sort Key: t.id DESC
                                     Sort Method: top-N heapsort  Memory: 2164kB
                                     Buffers: shared hit=73028 read=5206 written=25
                                     ->  Hash Semi Join  (cost=18019.06..32679.85 rows=733 width=955) (actual time=24.031..180.049 rows=15643 loops=1)
                                           Hash Cond: ((t.document_id = d.id) AND (t.version_number = d.current_version))
                                           Buffers: shared hit=73028 read=5206 written=25
                                           ->  Index Scan using document_texts_office_id_idx on document_texts t  (cost=0.42..14571.58 rows=15363 width=991) (actual time=0.227..148.592 rows=15643 loops=1)
                                                 Index Cond: (office_id = '01a1fe5c-0e50-75ea-bbd8-47f6893e7cdf'::uuid)
                                                 Filter: ((search_vector_simple @@ websearch_to_tsquery('simple'::regconfig, lower(translate(regexp_replace(unaccent('ايجار'::text), '[ً-ٰٟـ]'::text, ''::text, 'g'::text), 'أإآٱىئؤة'::text, 'ااااييوه'::text)))) OR (search_vector_english @@ websearch_to_tsquery('english'::regconfig, unaccent('ايجار'::text))))
                                                 Rows Removed by Filter: 4357
```

## 3. Search: tasks (assigned-scope reader)

1014 calls · mean 64.4 ms · max 590.2 ms · total 65.3 s

Slowest logged plan:

```
Limit  (cost=18848.71..18848.72 rows=6 width=40) (actual time=95.019..95.028 rows=6 loops=1)
Buffers: shared hit=3537 read=2003 written=9
CTE q
->  Result  (cost=0.00..0.52 rows=1 width=96) (actual time=0.026..0.027 rows=1 loops=1)
CTE hits
->  Limit  (cost=16305.87..16305.89 rows=6 width=24) (actual time=94.947..94.952 rows=6 loops=1)
   Buffers: shared hit=3531 read=2003 written=9
   ->  Sort  (cost=16305.87..16307.19 rows=525 width=24) (actual time=94.946..94.951 rows=6 loops=1)
         Sort Key: ((('1'::double precision + ts_rank(t_1.search_vector_simple, q_1.s)) + ts_rank(t_1.search_vector_english, q_1.e))) DESC, t_1.id
         Sort Method: top-N heapsort  Memory: 25kB
         Buffers: shared hit=3531 read=2003 written=9
         ->  Nested Loop  (cost=16284.63..16296.46 rows=525 width=24) (actual time=94.876..94.921 rows=123 loops=1)
               Buffers: shared hit=3531 read=2003 written=9
               ->  CTE Scan on q q_1  (cost=0.00..0.02 rows=1 width=64) (actual time=0.028..0.030 rows=1 loops=1)
               ->  Limit  (cost=16284.63..16285.94 rows=525 width=136) (actual time=94.842..94.857 rows=123 loops=1)
                     Buffers: shared hit=3531 read=2003 written=9
                     ->  Sort  (cost=16284.63..16285.94 rows=525 width=136) (actual time=94.841..94.849 rows=123 loops=1)
                           Sort Key: t_1.id DESC
                           Sort Method: quicksort  Memory: 56kB
                           Buffers: shared hit=3531 read=2003 written=9
                           ->  Bitmap Heap Scan on tasks t_1  (cost=3635.17..16260.91 rows=525 width=136) (actual time=91.913..94.767 rows=123 loops=1)
                                 Recheck Cond: ((office_id = '01a1fe5d-0e2f-749a-b2b7-7242ea1761c2'::uuid) AND ((search_vector_simple @@ websearch_to_tsquery('simple'::regconfig, lower(translate(regexp_replace(unaccent('تعويض'::text), '[ً-ٰٟـ]'::text, ''::text, 'g'::text), 'أإآٱىئؤة'::text, 'ااااييوه'::text)))) OR (search_vector_english @@ websearch_to_tsquery('english'::regconfig, unaccent('تعويض'::text)))))
                                 Filter: (((file_id IS NULL) AND ((created_by_id = '01a1fe5d-0e3e-735c-a47d-c0ddc5b5e1d7'::uuid) OR (assigned_to_id = '01a1fe5d-0e3e-735c-a47d-c0ddc5b5e1d7'::uuid))) OR (ANY ((file_id = (hashed SubPlan 7).col1) AND (office_id = (hashed SubPlan 7).col2))))
                                 Rows Removed by Filter: 388
                                 Heap Blocks: exact=283
                                 Buffers: shared hit=3531 read=2003 written=9
                                 ->  BitmapAnd  (cost=3635.17..3635.17 rows=1078 width=0) (actual time=11.389..11.391 rows=0 loops=1)
                                       Buffers: shared hit=789 read=28
                                       ->  Bitmap Index Scan on tasks_office_id_assigned_to_id_status_due_date_idx  (cost=0.00..142.52 rows=9880 width=0) (actual time=0.636..0.637 rows=10000 loops=1)
                                             Index Cond: (office_id = '01a1fe5d-0e2f-749a-b2b7-7242ea1761c2'::uuid)
```

## 4. Dashboard: recent activity (timeline of my files)

1430 calls · mean 34.7 ms · max 73.8 ms · total 49.6 s

Slowest logged plan:

```
Limit  (cost=0.85..80.86 rows=20 width=182) (actual time=59.564..59.566 rows=0 loops=1)
Buffers: shared hit=44596 read=882 dirtied=50
->  Nested Loop  (cost=0.85..50894.03 rows=12722 width=182) (actual time=59.563..59.565 rows=0 loops=1)
 Buffers: shared hit=44596 read=882 dirtied=50
 ->  Index Scan using case_timeline_events_office_id_occurred_at_id_idx on case_timeline_events  (cost=0.42..22576.06 rows=25445 width=154) (actual time=0.133..24.364 rows=25334 loops=1)
       Index Cond: (office_id = '01a1fe5c-595c-718f-8286-31947dcb8b6e'::uuid)
       Buffers: shared hit=24601 read=877 dirtied=50
 ->  Memoize  (cost=0.43..1.21 rows=1 width=32) (actual time=0.001..0.001 rows=0 loops=25334)
       Cache Key: case_timeline_events.file_id
       Cache Mode: logical
       Hits: 20334  Misses: 5000  Evictions: 0  Overflows: 0  Memory Usage: 391kB
       Buffers: shared hit=19995 read=5
       ->  Index Scan using legal_files_pkey on legal_files j0  (cost=0.42..1.20 rows=1 width=32) (actual time=0.004..0.004 rows=0 loops=5000)
             Index Cond: (id = case_timeline_events.file_id)
             Filter: ((deleted_at IS NULL) AND (office_id = '01a1fe5c-595c-718f-8286-31947dcb8b6e'::uuid) AND ((responsible_lawyer_id = '01a1fe5c-5961-70cf-94b5-8d48fbd7f74b'::uuid) OR (responsible_paralegal_id = '01a1fe5c-5961-70cf-94b5-8d48fbd7f74b'::uuid) OR EXISTS(SubPlan 1)))
             Rows Removed by Filter: 1
             Buffers: shared hit=19995 read=5
             SubPlan 1
               ->  Seq Scan on file_team_members t1  (cost=0.00..0.00 rows=1 width=0) (actual time=0.000..0.000 rows=0 loops=5000)
                     Filter: ((user_id = '01a1fe5c-5961-70cf-94b5-8d48fbd7f74b'::uuid) AND (j0.id = file_id) AND (j0.office_id = office_id))
```

## 5. Search: tasks (office-wide reader)

1007 calls · mean 39.3 ms · max 748.4 ms · total 39.6 s

Slowest logged plan:

```
Limit  (cost=19152.27..19152.29 rows=6 width=40) (actual time=67.741..67.751 rows=6 loops=1)
Buffers: shared hit=1504 read=4033
CTE q
->  Result  (cost=0.00..0.52 rows=1 width=96) (actual time=0.011..0.012 rows=1 loops=1)
CTE hits
->  Limit  (cost=16609.93..16609.95 rows=6 width=24) (actual time=67.685..67.690 rows=6 loops=1)
   Buffers: shared hit=1504 read=4033
   ->  Sort  (cost=16609.93..16611.29 rows=543 width=24) (actual time=67.684..67.689 rows=6 loops=1)
         Sort Key: ((('1'::double precision + ts_rank(t_1.search_vector_simple, q_1.s)) + ts_rank(t_1.search_vector_english, q_1.e))) DESC, t_1.id
         Sort Method: top-N heapsort  Memory: 25kB
         Buffers: shared hit=1504 read=4033
         ->  Nested Loop  (cost=16587.96..16600.20 rows=543 width=24) (actual time=67.347..67.593 rows=520 loops=1)
               Buffers: shared hit=1504 read=4033
               ->  CTE Scan on q q_1  (cost=0.00..0.02 rows=1 width=64) (actual time=0.012..0.015 rows=1 loops=1)
               ->  Limit  (cost=16587.96..16589.32 rows=543 width=136) (actual time=67.330..67.395 rows=520 loops=1)
                     Buffers: shared hit=1504 read=4033
                     ->  Sort  (cost=16587.96..16589.32 rows=543 width=136) (actual time=67.329..67.360 rows=520 loops=1)
                           Sort Key: t_1.id DESC
                           Sort Method: quicksort  Memory: 154kB
                           Buffers: shared hit=1504 read=4033
                           ->  Bitmap Heap Scan on tasks t_1  (cost=3646.10..16563.30 rows=543 width=136) (actual time=10.012..67.099 rows=520 loops=1)
                                 Recheck Cond: ((office_id = '01a1fe5d-0e2f-749a-b2b7-7242ea1761c2'::uuid) AND ((search_vector_simple @@ websearch_to_tsquery('simple'::regconfig, lower(translate(regexp_replace(unaccent('lease'::text), '[ً-ٰٟـ]'::text, ''::text, 'g'::text), 'أإآٱىئؤة'::text, 'ااااييوه'::text)))) OR (search_vector_english @@ websearch_to_tsquery('english'::regconfig, unaccent('lease'::text)))))
                                 Filter: (((file_id IS NULL) AND ((created_by_id = '01a1fe5d-0e37-74c9-9366-85e45c663554'::uuid) OR (assigned_to_id = '01a1fe5d-0e37-74c9-9366-85e45c663554'::uuid))) OR (ANY ((file_id = (hashed SubPlan 3).col1) AND (office_id = (hashed SubPlan 3).col2))))
                                 Heap Blocks: exact=286
                                 Buffers: shared hit=1504 read=4033
                                 ->  BitmapAnd  (cost=3646.10..3646.10 rows=1105 width=0) (actual time=9.964..9.966 rows=0 loops=1)
                                       Buffers: shared hit=808 read=9
                                       ->  Bitmap Index Scan on tasks_office_id_assigned_to_id_status_due_date_idx  (cost=0.00..142.52 rows=9880 width=0) (actual time=0.439..0.439 rows=10000 loops=1)
                                             Index Cond: (office_id = '01a1fe5d-0e2f-749a-b2b7-7242ea1761c2'::uuid)
                                             Buffers: shared hit=19
```

## 6. Dashboard: new documents count

1437 calls · mean 15.2 ms · max 31.5 ms · total 21.9 s

Slowest logged plan:

```
Aggregate  (cost=12540.50..12540.51 rows=1 width=8) (actual time=24.651..24.657 rows=1 loops=1)
Buffers: shared hit=5224 read=952
->  Nested Loop Left Join  (cost=4907.61..12533.57 rows=554 width=16) (actual time=6.238..24.603 rows=112 loops=1)
 Filter: ((NOT documents.is_confidential) OR (documents.uploaded_by_id = '01a1fe5b-5f6e-71b8-a901-a9ed20a5988f'::uuid) OR (((j2.responsible_lawyer_id = '01a1fe5b-5f6e-71b8-a901-a9ed20a5988f'::uuid) OR (j2.responsible_paralegal_id = '01a1fe5b-5f6e-71b8-a901-a9ed20a5988f'::uuid) OR EXISTS(SubPlan 3)) AND (j2.id IS NOT NULL)))
 Buffers: shared hit=5224 read=952
 ->  Nested Loop  (cost=4907.20..10077.06 rows=562 width=49) (actual time=6.220..24.056 rows=112 loops=1)
       Buffers: shared hit=4779 read=949
       ->  Hash Join  (cost=4906.77..9666.16 rows=71 width=64) (actual time=6.156..12.857 rows=1250 loops=1)
             Hash Cond: (j0.id = j4.id)
             Buffers: shared hit=454
             ->  Bitmap Heap Scan on legal_files j0  (cost=60.51..4812.88 rows=2671 width=32) (actual time=0.199..6.072 rows=1250 loops=1)
                   Recheck Cond: (office_id = '01a1fe5b-5f52-708e-8ff9-0e5bf2ecd50f'::uuid)
                   Filter: ((deleted_at IS NULL) AND ((responsible_lawyer_id = '01a1fe5b-5f6e-71b8-a901-a9ed20a5988f'::uuid) OR (responsible_paralegal_id = '01a1fe5b-5f6e-71b8-a901-a9ed20a5988f'::uuid) OR EXISTS(SubPlan 1)))
                   Rows Removed by Filter: 3750
                   Heap Blocks: exact=222
                   Buffers: shared hit=227
                   ->  Bitmap Index Scan on legal_files_office_id_responsible_lawyer_id_idx  (cost=0.00..59.84 rows=5273 width=0) (actual time=0.168..0.169 rows=5000 loops=1)
                         Index Cond: (office_id = '01a1fe5b-5f52-708e-8ff9-0e5bf2ecd50f'::uuid)
                         Buffers: shared hit=5
                   SubPlan 1
                     ->  Seq Scan on file_team_members t1  (cost=0.00..0.00 rows=1 width=0) (actual time=0.000..0.000 rows=0 loops=3750)
                           Filter: ((user_id = '01a1fe5b-5f6e-71b8-a901-a9ed20a5988f'::uuid) AND (j0.id = file_id) AND (j0.office_id = office_id))
             ->  Hash  (cost=4812.88..4812.88 rows=2671 width=32) (actual time=5.935..5.938 rows=1250 loops=1)
                   Buckets: 4096  Batches: 1  Memory Usage: 111kB
                   Buffers: shared hit=227
                   ->  Bitmap Heap Scan on legal_files j4  (cost=60.51..4812.88 rows=2671 width=32) (actual time=0.170..5.503 rows=1250 loops=1)
                         Recheck Cond: (office_id = '01a1fe5b-5f52-708e-8ff9-0e5bf2ecd50f'::uuid)
                         Filter: ((responsible_lawyer_id = '01a1fe5b-5f6e-71b8-a901-a9ed20a5988f'::uuid) OR (responsible_paralegal_id = '01a1fe5b-5f6e-71b8-a901-a9ed20a5988f'::uuid) OR EXISTS(SubPlan 5))
                         Rows Removed by Filter: 3750
                         Heap Blocks: exact=222
```

## 7. Search: files (assigned-scope reader)

1014 calls · mean 15.3 ms · max 135.8 ms · total 15.5 s

Slowest logged plan:

```
Limit  (cost=3575.34..3575.36 rows=6 width=40) (actual time=23.387..23.413 rows=6 loops=1)
Buffers: shared hit=592 read=533
CTE q
->  Result  (cost=0.00..0.52 rows=1 width=96) (actual time=0.014..0.014 rows=1 loops=1)
CTE hits
->  Limit  (cost=1365.15..1365.16 rows=3 width=24) (actual time=2.780..2.791 rows=1 loops=1)
   Buffers: shared hit=303 read=10
   ->  Sort  (cost=1365.15..1365.16 rows=3 width=24) (actual time=2.780..2.789 rows=1 loops=1)
         Sort Key: ((('1'::double precision + ts_rank(t_1.search_vector_simple, q_1.s)) + ts_rank(t_1.search_vector_english, q_1.e))) DESC, t_1.id
         Sort Method: quicksort  Memory: 25kB
         Buffers: shared hit=303 read=10
         ->  Nested Loop  (cost=1365.04..1365.12 rows=3 width=24) (actual time=2.775..2.786 rows=1 loops=1)
               Buffers: shared hit=303 read=10
               ->  CTE Scan on q q_1  (cost=0.00..0.02 rows=1 width=64) (actual time=0.015..0.017 rows=1 loops=1)
               ->  Limit  (cost=1365.04..1365.04 rows=3 width=184) (actual time=2.757..2.765 rows=1 loops=1)
                     Buffers: shared hit=303 read=10
                     ->  Sort  (cost=1365.04..1365.04 rows=3 width=184) (actual time=2.756..2.762 rows=1 loops=1)
                           Sort Key: t_1.id DESC
                           Sort Method: quicksort  Memory: 25kB
                           Buffers: shared hit=303 read=10
                           ->  Bitmap Heap Scan on legal_files t_1  (cost=1342.84..1365.01 rows=3 width=184) (actual time=2.729..2.758 rows=1 loops=1)
                                 Recheck Cond: ((office_id = '01a1fe5c-595c-718f-8286-31947dcb8b6e'::uuid) AND ((search_vector_simple @@ websearch_to_tsquery('simple'::regconfig, lower(translate(regexp_replace(unaccent('كلمة1957'::text), '[ً-ٰٟـ]'::text, ''::text, 'g'::text), 'أإآٱىئؤة'::text, 'ااااييوه'::text)))) OR (search_vector_english @@ websearch_to_tsquery('english'::regconfig, unaccent('كلمة1957'::text)))))
                                 Filter: ((deleted_at IS NULL) AND ((responsible_lawyer_id = '01a1fe5c-5966-749d-afde-2f36b70411b9'::uuid) OR (responsible_paralegal_id = '01a1fe5c-5966-749d-afde-2f36b70411b9'::uuid) OR EXISTS(SubPlan 2)))
                                 Rows Removed by Filter: 5
                                 Heap Blocks: exact=6
                                 Buffers: shared hit=303 read=10
                                 ->  BitmapAnd  (cost=1342.84..1342.84 rows=5 width=0) (actual time=2.700..2.703 rows=0 loops=1)
                                       Buffers: shared hit=301 read=6
                                       ->  Bitmap Index Scan on legal_files_office_id_responsible_lawyer_id_idx  (cost=0.00..57.94 rows=5020 width=0) (actual time=0.156..0.156 rows=5000 loops=1)
                                             Index Cond: (office_id = '01a1fe5c-595c-718f-8286-31947dcb8b6e'::uuid)
```

## 8. Search: files (office-wide reader)

1007 calls · mean 15.3 ms · max 383.8 ms · total 15.4 s

Slowest logged plan:

```
Limit  (cost=3597.98..3598.00 rows=6 width=40) (actual time=25.432..25.446 rows=6 loops=1)
Buffers: shared hit=941 read=164
CTE q
->  Result  (cost=0.00..0.52 rows=1 width=96) (actual time=0.013..0.014 rows=1 loops=1)
CTE hits
->  Limit  (cost=1387.41..1387.42 rows=6 width=24) (actual time=2.758..2.766 rows=4 loops=1)
   Buffers: shared hit=309 read=2
   ->  Sort  (cost=1387.41..1387.43 rows=10 width=24) (actual time=2.757..2.765 rows=4 loops=1)
         Sort Key: ((('1'::double precision + ts_rank(t_1.search_vector_simple, q_1.s)) + ts_rank(t_1.search_vector_english, q_1.e))) DESC, t_1.id
         Sort Method: quicksort  Memory: 25kB
         Buffers: shared hit=309 read=2
         ->  Nested Loop  (cost=1386.99..1387.24 rows=10 width=24) (actual time=2.749..2.760 rows=4 loops=1)
               Buffers: shared hit=309 read=2
               ->  CTE Scan on q q_1  (cost=0.00..0.02 rows=1 width=64) (actual time=0.014..0.016 rows=1 loops=1)
               ->  Limit  (cost=1386.99..1387.02 rows=10 width=184) (actual time=2.729..2.735 rows=4 loops=1)
                     Buffers: shared hit=309 read=2
                     ->  Sort  (cost=1386.99..1387.02 rows=10 width=184) (actual time=2.728..2.733 rows=4 loops=1)
                           Sort Key: t_1.id DESC
                           Sort Method: quicksort  Memory: 26kB
                           Buffers: shared hit=309 read=2
                           ->  Bitmap Heap Scan on legal_files t_1  (cost=1342.95..1386.83 rows=10 width=184) (actual time=2.706..2.724 rows=4 loops=1)
                                 Recheck Cond: ((office_id = '01a1fe5c-0e50-75ea-bbd8-47f6893e7cdf'::uuid) AND ((search_vector_simple @@ websearch_to_tsquery('simple'::regconfig, lower(translate(regexp_replace(unaccent('كلمة398'::text), '[ً-ٰٟـ]'::text, ''::text, 'g'::text), 'أإآٱىئؤة'::text, 'ااااييوه'::text)))) OR (search_vector_english @@ websearch_to_tsquery('english'::regconfig, unaccent('كلمة398'::text)))))
                                 Filter: (deleted_at IS NULL)
                                 Heap Blocks: exact=4
                                 Buffers: shared hit=309 read=2
                                 ->  BitmapAnd  (cost=1342.95..1342.95 rows=10 width=0) (actual time=2.694..2.697 rows=0 loops=1)
                                       Buffers: shared hit=305 read=2
                                       ->  Bitmap Index Scan on legal_files_office_id_responsible_lawyer_id_idx  (cost=0.00..57.51 rows=4963 width=0) (actual time=0.195..0.195 rows=5000 loops=1)
                                             Index Cond: (office_id = '01a1fe5c-0e50-75ea-bbd8-47f6893e7cdf'::uuid)
                                             Buffers: shared hit=5
```

## 9. Dashboard: team overdue tasks per assignee

1430 calls · mean 7.9 ms · max 17.7 ms · total 11.3 s

_No execution over 15 ms in the plan-capture run._

## 10. Upload: storage quota sum

5688 calls · mean 1.9 ms · max 28.7 ms · total 11.0 s

_No execution over 15 ms in the plan-capture run._
