# Bank Card Number Field Plugin

## Introduction

This is a field plugin for displaying and inputting bank card numbers, providing formatted display, smart input, and smart copy features.

## Bank Card Number Format Description

### Common Bank Card Number Digits

Different banks have different card number lengths and display formats:

- **16 digits**: Common, typically displayed as **4-4-4-4** on the card
  - Example: `6222 0000 0000 0000`
- **19 digits**: Common, typically displayed as **6-13** on the card
  - Example: `622200 0000000000000`
- **15 digits**: Uncommon, such as American Express, displayed as **4-6-5** on the card
  - Example: `3782 822463 10005`
- **18 digits**: Uncommon, such as Industrial Bank, displayed as **6-6-6** on the card
  - Example: `622909 000000 000000`

### Design of This Plugin

To provide a unified and simple user experience, this plugin follows the design philosophy of Alipay and WeChat:

- **Unified Format**: All bank card numbers are uniformly displayed in **groups of 4 digits**
- **Maximum Length**: Although the standard maximum length for bank card numbers is 19 digits, following Alipay's design, this plugin supports up to **21 digits** to accommodate potential special card numbers
- **Last Group**: When the card number has 21 digits, the format is **4-4-4-4-5** (the last group has 5 digits)

## Features

### Key Features

- **Formatted Display**: Bank card numbers are automatically formatted into groups of 4 digits
  - 16 digits: `1234 5678 9012 3456`
  - 19 digits: `1234 5678 9012 3456 789`
  - 21 digits: `1234 5678 9012 3456 78901`
  
- **Smart Input**: Spaces are automatically added as separators during input, no manual spacing required

- **Smart Copy**: When copying bank card numbers, spaces are automatically removed, copying only pure digits
  - Display: `6222 0000 0000 0000`
  - Copy: `6222000000000000`
  - Convenient for pasting into other systems (such as bank websites, payment platforms, etc.)

- **Data Storage**: Database stores pure numeric format (without spaces)

- **Length Limit**: Supports up to 21 digits

- **Auto Filtering**: Automatically filters non-numeric characters during input

## Usage

1. Enable the "Bank Card Number Field" plugin in plugin management
2. When creating or editing a data table, add a new field and select "Bank Card Number" as the field type
3. Configure the field name, display name, and other basic information
4. Save and the field can be used in forms

### User Experience

- **During Input**: Enter digits directly, system automatically adds space separators
- **During Display**: Automatically formatted into readable groups
- **During Copy**: Ctrl+C or right-click copy automatically removes spaces

