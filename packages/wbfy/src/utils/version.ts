export function convertVersionIntoNumber(version: string): number {
  // e.g. java adoptopenjdk-11.0.17+8
  const numbers = version
    .split(/[+.-]/)
    .map(Number)
    .filter((num) => !Number.isNaN(num));
  let versionNumber = 0;
  let divisor = 1;
  for (const num of numbers) {
    versionNumber += num * divisor;
    divisor /= 1000;
  }
  return versionNumber;
}
