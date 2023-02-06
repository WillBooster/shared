import { stringify } from 'csv-stringify';

generate({
  length: 20,
  objectMode: true,
  seed: 1,
  headers: 2,
  duration: 400,
})
  .pipe(
    stringify({
      header: true,
      columns: {
        year: 'birthYear',
        phone: 'phone',
      },
    })
  )
  .pipe(process.stdout);
