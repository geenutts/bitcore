import { address as SolAddress } from '@solana/kit'
import { IValidation } from '..';

export class SolValidation implements IValidation {
  regex: RegExp;

  constructor() {
    this.regex = /solana/i;
  }

  validateAddress(_network: string, address: string): boolean {
    try {
      SolAddress(address);
      return true;
    } catch (error) {
      return false;
    }
  }

  validateUri(addressUri: string): boolean {
    if (!addressUri) {
      return false;
    }
    const address = this.extractAddress(addressUri);
    const prefix = this.regex.exec(addressUri);
    return !!prefix && this.validateAddress('livenet', address);
  }

  private extractAddress(data) {
    const prefix = /^[a-z]+:/i;
    const params = /([\?\&](amount|fee)=(\d+([\,\.]\d+)?))+/i;
    return data.replace(prefix, '').replace(params, '');
  }
}