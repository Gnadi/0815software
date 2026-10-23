import org.mustangproject.validator.ZUGFeRDValidator;

/**
 * Validate many e-invoice files in one JVM with Mustang's own validator — the
 * class `java -jar Mustang-CLI.jar --action validate` runs, with the same
 * report, but without paying the JVM start and the schematron compilation for
 * every file: the 330 files of validate-einvoice.sh take under half a minute,
 * where one CLI run per file (four at a time) took twelve.
 *
 *   java -cp Mustang-CLI-2.26.0.jar scripts/MustangBatch.java <file>...
 *
 * Prints "valid    <name>" or "INVALID  <name>" with the report's errors and
 * warnings, and exits 1 when any file is invalid. A file the validator throws
 * on counts as invalid, so a crash can never read as a pass. A fresh validator
 * per file keeps one file's result out of the next.
 */
public class MustangBatch {
  public static void main(String[] files) {
    // xargs runs the command once even on empty input: nothing validated must
    // not pass as everything valid.
    if (files.length == 0) {
      System.out.println("INVALID  no files given");
      System.exit(1);
    }
    boolean allValid = true;
    for (String file : files) {
      String name = new java.io.File(file).getName();
      String report;
      try {
        ZUGFeRDValidator validator = new ZUGFeRDValidator();
        validator.disableNotices();
        report = validator.validate(file);
      } catch (Exception e) {
        report = "<error>validator threw " + e + "</error>";
      }
      if (report.contains("<summary status=\"valid\"/>")) {
        System.out.println("valid    " + name);
        continue;
      }
      allValid = false;
      System.out.println("INVALID  " + name);
      // The report repeats each rule's whole XPath test and qualifies every
      // step with its namespace; without both, the line says which rule
      // failed on which element.
      report
          .lines()
          .filter(l -> l.contains("<error") || l.contains("<warning"))
          .limit(10)
          .map(l -> l.trim().replaceAll(" criterion=\"[^\"]*\"", "").replaceAll("\\[namespace-uri\\(\\)='[^']*'\\]", ""))
          .forEach(l -> System.out.println("  " + l));
    }
    System.exit(allValid ? 0 : 1);
  }
}
