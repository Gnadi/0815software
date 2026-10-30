# The Office Open XML schemas (ECMA-376, 5th edition)

Published by **Ecma International**, downloaded unchanged from
<https://ecma-international.org/publications-and-standards/standards/ecma-376/>:

| Files | From |
| --- | --- |
| `sml.xsd` and what it imports (`dml-*.xsd`, `shared-*.xsd`) | ECMA-376 Part 4 (December 2016), `OfficeOpenXML-XMLSchema-Transitional.zip` |
| `opc-contentTypes.xsd`, `opc-relationships.xsd` | ECMA-376 Part 2 (December 2021), `OpenPackagingConventions-XMLSchema.zip` |

**Transitional**, not Strict: Transitional SpreadsheetML
(`http://schemas.openxmlformats.org/spreadsheetml/2006/main`) is what Excel,
LibreOffice and Google Sheets write and read by default. The Strict schemas in
Part 1 use other namespaces and are not what this module produces.

## How they are used

`test/xlsx.test.ts` unpacks every workbook the module writes and hands each
part to `xmllint --schema`: the content types, both relationship parts, the
workbook, the styles and every worksheet. A part that does not validate fails
the test. Like the SEPA check in MOD-04, the test skips — and says so — when
`xmllint` is not installed, rather than pass without having looked.

One known gap between the schema and the standard's own text: §18.4.12 of
Part 1 lists `xml:space` as an attribute of a cell's text element `<t>` (Excel
writes it for text with leading or trailing spaces), while `sml.xsd` gives the
element a simple type without attributes. The prose is the definition, so the
module writes the attribute and the test removes exactly that attribute before
validating — nothing else.

The `dml-*.xsd` files are here only because `sml.xsd` imports them (a
worksheet may hold drawings); this module writes none.
