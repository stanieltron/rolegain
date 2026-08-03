# Validate one vacancy lead

`validateOneVacancy(input)` is the public per-lead boundary. It acquires and
interprets the actual page, checks that the vacancy is current, resolves the
application destination, and returns only concrete validated vacancies.

A job-list or careers-page lead is expansion input, never a matchable vacancy.
Its concrete children are recursively validated and returned independently.
