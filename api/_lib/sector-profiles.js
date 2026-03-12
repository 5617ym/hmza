
const bank = require("./profiles/bank-profile");
const insurance = require("./profiles/insurance-profile");
const operating = require("./profiles/operating-profile");
const reit = require("./profiles/reit-profile");

module.exports = {
  bank,
  insurance,
  operating_company: operating,
  reit
};
